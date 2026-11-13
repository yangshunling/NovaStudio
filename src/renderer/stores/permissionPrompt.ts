/**
 * 工具授权询问队列
 *
 * 主进程把 CLI 的 can_use_tool 请求推过来，这里维护待处理列表。
 * 多个会话可以同时有请求，界面按到达顺序逐个处理。
 *
 * 请求是带外的：不进入消息流、不落库；重载后由 agent:permission:list 恢复。
 */

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { toast } from "./toast";
import { errorMessage } from "@shared/error";
import type {
  PermissionPromptResolved,
  PermissionPromptView,
} from "@shared/permission-prompt";

interface PermissionPromptState {
  /** requestId → 请求视图 */
  byId: Record<string, PermissionPromptView>;
  /** 到达顺序（只存仍待处理的 requestId） */
  order: string[];
  /** 当前展示的 requestId */
  activeId: string | null;
  /** 正在提交回答，防止双击 */
  submitting: boolean;
  /** 每个会话的待处理数量（会话列表角标用；保持引用稳定） */
  countBySession: Record<string, number>;

  /** 重载后合并主进程的待处理列表 */
  hydrate: (views: PermissionPromptView[]) => void;
  enqueue: (view: PermissionPromptView) => void;
  resolve: (resolved: PermissionPromptResolved) => void;
  /** 会话被删除 / 运行结束时清空 */
  clearSession: (sessionId: string) => void;
  /** 回答指定请求；失败时移除并提示 */
  answer: (requestId: string, behavior: "allow" | "deny") => Promise<void>;
}

export const usePermissionPromptStore = create<PermissionPromptState>(
  (set, get) => ({
    byId: {},
    order: [],
    activeId: null,
    submitting: false,
    countBySession: {},

    hydrate: (views) => {
      if (views.length === 0) return;
      set((state) => {
        const byId = { ...state.byId };
        const order = [...state.order];
        const countBySession = { ...state.countBySession };
        for (const view of views) {
          if (byId[view.requestId]) continue;
          byId[view.requestId] = view;
          order.push(view.requestId);
          countBySession[view.sessionId] =
            (countBySession[view.sessionId] ?? 0) + 1;
        }
        return {
          byId,
          order,
          countBySession,
          activeId: state.activeId ?? order[0] ?? null,
        };
      });
    },

    enqueue: (view) => {
      if (get().byId[view.requestId]) return;
      set((state) => ({
        byId: { ...state.byId, [view.requestId]: view },
        order: [...state.order, view.requestId],
        activeId: state.activeId ?? view.requestId,
        countBySession: {
          ...state.countBySession,
          [view.sessionId]: (state.countBySession[view.sessionId] ?? 0) + 1,
        },
      }));
    },

    resolve: (resolved) => {
      set((state) => {
        if (!state.byId[resolved.requestId]) return state;
        const byId = { ...state.byId };
        delete byId[resolved.requestId];
        const order = state.order.filter((id) => id !== resolved.requestId);
        const count = state.countBySession[resolved.sessionId] ?? 0;
        const countBySession = { ...state.countBySession };
        if (count <= 1) delete countBySession[resolved.sessionId];
        else countBySession[resolved.sessionId] = count - 1;
        return {
          byId,
          order,
          countBySession,
          activeId:
            state.activeId === resolved.requestId
              ? (order[0] ?? null)
              : state.activeId,
        };
      });
    },

    clearSession: (sessionId) => {
      set((state) => {
        const removed = Object.values(state.byId)
          .filter((view) => view.sessionId === sessionId)
          .map((view) => view.requestId);
        if (removed.length === 0) return state;
        const byId = { ...state.byId };
        for (const id of removed) delete byId[id];
        const order = state.order.filter((id) => !removed.includes(id));
        const countBySession = { ...state.countBySession };
        delete countBySession[sessionId];
        return {
          byId,
          order,
          countBySession,
          activeId:
            state.activeId && removed.includes(state.activeId)
              ? (order[0] ?? null)
              : state.activeId,
        };
      });
    },

    answer: async (requestId, behavior) => {
      const { byId, submitting, resolve } = get();
      const view = byId[requestId];
      if (!view || submitting) return;

      set({ submitting: true });
      try {
        const result = await ipc.respondPermission(
          view.sessionId,
          view.requestId,
          behavior === "allow"
            ? { behavior: "allow" }
            : {
                behavior: "deny",
                message: "用户在 Nova 中拒绝了这次工具调用",
                interrupt: false,
              },
        );
        // 主进程可能已先推 resolved：resolve 幂等，重复调用无副作用
        resolve({
          sessionId: view.sessionId,
          requestId: view.requestId,
          reason: "answered",
          behavior,
        });
        if (!result.ok) toast.error(result.error);
      } catch (err) {
        resolve({
          sessionId: view.sessionId,
          requestId: view.requestId,
          reason: "answered",
          behavior,
        });
        toast.error(errorMessage(err));
      } finally {
        set({ submitting: false });
      }
    },
  }),
);
