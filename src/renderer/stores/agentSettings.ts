/**
 * Agent 本机配置的共享快照
 *
 * 配置的事实来源是主进程（`~/.claude/settings.json`）。此前渲染层在
 * ModelSelector / AgentsView / ContextGauge 各存一份，并用 CustomEvent 广播
 * 纠偏：改完配置后部分界面仍是旧值，上下文占用甚至要重启才更新。
 *
 * 现在统一由这个 store 持有快照：
 *   - 读者（默认模型名、上下文窗口）只订阅，不各自发请求；
 *   - 写者（Agent 配置页保存 / 重新读取）写回 store，所有读者立即更新。
 */

import { useEffect } from "react";
import { create } from "zustand";
import type { AgentSettingsView } from "@shared/contracts/agent";
import { errorMessage } from "@shared/error";
import { ipc } from "../lib/ipc";

interface AgentSettingsState {
  byAgent: Record<string, AgentSettingsView>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  /** 读取快照；已有缓存时直接返回，force 时重新读取 */
  load: (
    agentId: string,
    options?: { force?: boolean },
  ) => Promise<AgentSettingsView | null>;
  /** 配置页读取 / 保存后写回，驱动所有读者重渲染 */
  setView: (agentId: string, view: AgentSettingsView) => void;
  /** 丢弃缓存，下次读取走主进程 */
  invalidate: (agentId: string) => void;
}

/** 同一 Agent 的并发读取合并成一次请求 */
const inFlight = new Map<string, Promise<AgentSettingsView | null>>();

export const useAgentSettingsStore = create<AgentSettingsState>((set, get) => ({
  byAgent: {},
  loading: {},
  error: {},

  load: async (agentId, options) => {
    const cached = get().byAgent[agentId];
    if (cached && !options?.force) return cached;

    const pending = inFlight.get(agentId);
    if (pending) return pending;

    set((state) => ({
      loading: { ...state.loading, [agentId]: true },
      error: { ...state.error, [agentId]: null },
    }));

    const promise = ipc
      .getAgentSettings(agentId)
      .then((view) => {
        set((state) => ({
          byAgent: { ...state.byAgent, [agentId]: view },
          loading: { ...state.loading, [agentId]: false },
        }));
        return view;
      })
      .catch((err) => {
        set((state) => ({
          loading: { ...state.loading, [agentId]: false },
          error: { ...state.error, [agentId]: errorMessage(err) },
        }));
        return null;
      })
      .finally(() => {
        inFlight.delete(agentId);
      });

    inFlight.set(agentId, promise);
    return promise;
  },

  setView: (agentId, view) =>
    set((state) => ({
      byAgent: { ...state.byAgent, [agentId]: view },
      error: { ...state.error, [agentId]: null },
    })),

  invalidate: (agentId) =>
    set((state) => {
      if (!(agentId in state.byAgent)) return state;
      const byAgent = { ...state.byAgent };
      delete byAgent[agentId];
      return { byAgent };
    }),
}));

/**
 * 组件读取配置：挂载时确保加载一次；保存后由 store 推送新值。
 *
 * 返回 null 表示尚未加载或读取失败 —— 调用方应有「未知」的展示分支，
 * 不要把 null 当成「没有配置」。
 */
export function useAgentSettings(
  agentId: string | null | undefined,
): AgentSettingsView | null {
  const view = useAgentSettingsStore((state) =>
    agentId ? state.byAgent[agentId] ?? null : null,
  );

  useEffect(() => {
    if (!agentId) return;
    void useAgentSettingsStore.getState().load(agentId);
  }, [agentId]);

  return view;
}
