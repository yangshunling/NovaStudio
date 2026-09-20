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
import { newId } from "../lib/utils";
import { useChatStore } from "./chat";
import type { AutomationTask, Message } from "@shared/types";

interface AutomationState {
  tasks: AutomationTask[];
  loadTasks: () => Promise<void>;
  createTask: (prompt: string, projectId: string, agentId: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  retryTask: (id: string) => Promise<void>;
  stopTask: (id: string) => Promise<void>;
  _onTaskUpdated: (task: AutomationTask) => void;
}

export const useAutomationStore = create<AutomationState>((set) => ({
  tasks: [],

  loadTasks: async () => {
    const tasks = await ipc.listAutomationTasks();
    set({ tasks });
  },

  createTask: async (prompt, projectId, agentId) => {
    await ipc.createAutomationTask(prompt, projectId, agentId);
    // 主进程会推送 automation:updated，但这里也立即刷新一次
    const tasks = await ipc.listAutomationTasks();
    set({ tasks });
  },

  deleteTask: async (id) => {
    await ipc.deleteAutomationTask(id);
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
  },

  retryTask: async (id) => {
    await ipc.retryAutomationTask(id);
    const tasks = await ipc.listAutomationTasks();
    set({ tasks });
  },

  stopTask: async (id) => {
    await ipc.stopAutomationTask(id);
    // 主进程会推送 automation:updated，这里也刷新一次保证列表即时一致
    const tasks = await ipc.listAutomationTasks();
    set({ tasks });
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

    // 任务完成/失败：复位流式标记
    if ((task.status === "completed" || task.status === "failed") && task.sessionId) {
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
}));
