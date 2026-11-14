/**
 * 自动化任务状态管理
 *
 * 与 chat store 独立，但共享 IPC 事件监听（useAgentStream 注册 automation:updated）。
 * 任务状态由主进程轮询器驱动：pending → running → completed/failed。
 *
 * 关键：当任务进入 running 且拿到 sessionId 时，需要在 chat store 中初始化
 * 消息桶（含用户消息）并设置 streamingBySession=true，这样 _onEvent 才能
 * 正确地将流式 delta 合并进同一条 assistant 消息（而非每条 delta 创建新消息）。
 */

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { newId, toMessage } from "../lib/utils";
import { toast } from "./toast";
import { useChatStore } from "./chat";
import { usePermissionPromptStore } from "./permissionPrompt";
import type { AutomationTask, Message } from "@shared/types";

interface AutomationState {
  tasks: AutomationTask[];
  /** 首次加载 / 手动刷新状态；任务为空时看板据此显示加载态 */
  loading: boolean;
  error: string | null;
  loadTasks: () => Promise<void>;
  createTask: (
    prompt: string,
    projectId: string,
    agentId: string,
    employeeId?: string | null,
  ) => Promise<void>;
  /** 返回是否真正执行成功；false 时调用方无需再提示（store 已 toast） */
  deleteTask: (id: string) => Promise<boolean>;
  retryTask: (id: string) => Promise<boolean>;
  stopTask: (id: string) => Promise<boolean>;
  _onTaskUpdated: (task: AutomationTask) => void;
}

export const useAutomationStore = create<AutomationState>((set) => {
  /** 操作后的静默回填：失败只提示，不再向外抛 */
  const refresh = async (): Promise<void> => {
    try {
      const tasks = await ipc.listAutomationTasks();
      set({ tasks, error: null });
    } catch (err) {
      const message = toMessage(err);
      set({ error: message });
      toast.error(message, 5000);
    }
  };

  return {
    tasks: [],
    loading: false,
    error: null,

    loadTasks: async () => {
      set({ loading: true, error: null });
      try {
        const tasks = await ipc.listAutomationTasks();
        set({ tasks, loading: false, error: null });
      } catch (err) {
        set({ loading: false, error: toMessage(err) });
        throw err;
      }
    },

    createTask: async (prompt, projectId, agentId, employeeId = null) => {
      await ipc.createAutomationTask(prompt, projectId, agentId, employeeId);
      // 主进程会推送 automation:updated，但这里也立即刷新一次
      await refresh();
    },

    deleteTask: async (id) => {
      try {
        const ok = await ipc.deleteAutomationTask(id);
        if (!ok) {
          toast.info("任务正在执行或状态已变化，暂时无法删除", 4000);
          await refresh();
          return false;
        }
        set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
        return true;
      } catch (err) {
        toast.error(toMessage(err), 5000);
        await refresh();
        return false;
      }
    },

    retryTask: async (id) => {
      try {
        const ok = await ipc.retryAutomationTask(id);
        if (!ok) toast.info("任务状态已变化，无法重试", 4000);
        await refresh();
        return ok;
      } catch (err) {
        toast.error(toMessage(err), 5000);
        await refresh();
        return false;
      }
    },

    stopTask: async (id) => {
      try {
        const ok = await ipc.stopAutomationTask(id);
        if (!ok) toast.info("任务已结束或状态已变化，无法停止", 4000);
        // 主进程会推送 automation:updated，这里也刷新一次保证列表即时一致
        await refresh();
        return ok;
      } catch (err) {
        toast.error(toMessage(err), 5000);
        await refresh();
        return false;
      }
    },

    _onTaskUpdated: (task) => {
      // 任务进入 running 且拿到 sessionId：在 chat store 初始化消息桶 + 流式标记
      if (task.status === "running" && task.sessionId) {
        const chat = useChatStore.getState();
        const sid = task.sessionId;
        if (!(sid in chat.messagesBySession)) {
          // 初始化用户消息（让详情抽屉能看到原始 prompt）
          const userMsg: Message = {
            id: newId(),
            role: "user",
            content: [{ type: "text", content: task.prompt }],
            timestamp: task.startedAt ?? Date.now(),
          };
          useChatStore.setState((s) => ({
            messagesBySession: { ...s.messagesBySession, [sid]: [userMsg] },
            streamingBySession: { ...s.streamingBySession, [sid]: true },
          }));
        } else if (!chat.streamingBySession[sid]) {
          // 已有桶但 streaming 未设（重试场景）
          useChatStore.setState((s) => ({
            streamingBySession: { ...s.streamingBySession, [sid]: true },
          }));
        }
      }

      // 任务完成/失败：复位流式标记，并清掉可能残留的授权询问
      if ((task.status === "completed" || task.status === "failed") && task.sessionId) {
        usePermissionPromptStore.getState().clearSession(task.sessionId);
        useChatStore.setState((s) => ({
          streamingBySession: { ...s.streamingBySession, [task.sessionId!]: false },
        }));
      }

      set((s) => {
        const idx = s.tasks.findIndex((t) => t.id === task.id);
        if (idx === -1) {
          return { tasks: [task, ...s.tasks] };
        }
        const tasks = [...s.tasks];
        tasks[idx] = task;
        return { tasks };
      });
    },
  };
});
