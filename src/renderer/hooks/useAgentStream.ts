/**
 * useAgentStream — 流式事件订阅 Hook
 *
 * 在组件挂载时注册 IPC 事件监听，卸载时自动清理。
 * 将主进程推送的事件路由到 Zustand store。
 */

import { useEffect } from "react";
import { ipc } from "../lib/ipc";
import { useChatStore } from "../stores/chat";
import { useAutomationStore } from "../stores/automation";
import { usePermissionPromptStore } from "../stores/permissionPrompt";

export function useAgentStream(): void {
  const _onEvent = useChatStore((s) => s._onEvent);
  const _onDone = useChatStore((s) => s._onDone);
  const _onAborted = useChatStore((s) => s._onAborted);
  // 用 selector 取 action，保证依赖稳定且绕开 getState 的非响应式调用
  const _onTaskUpdated = useAutomationStore((s) => s._onTaskUpdated);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    // 事件带 sessionId，按会话路由到对应消息桶（多会话并发）
    unsubs.push(ipc.on.agentEvent((payload) => _onEvent(payload)));
    unsubs.push(ipc.on.agentDone((data) => _onDone(data)));
    unsubs.push(ipc.on.agentAborted((data) => _onAborted(data)));
    // 收到 Agent 检测结果推送后刷新 store
    unsubs.push(
      ipc.on.agentsDetected((agents) => {
        useChatStore.setState({ agents });
      }),
    );
    unsubs.push(ipc.on.automationUpdated((task) => _onTaskUpdated(task)));

    // 工具授权询问：先订阅再拉取，避免重载期间漏掉已经挂起的请求
    unsubs.push(
      ipc.on.permissionRequest((payload) => {
        usePermissionPromptStore.getState().enqueue(payload);
      }),
    );
    unsubs.push(
      ipc.on.permissionResolved((payload) => {
        usePermissionPromptStore.getState().resolve(payload);
      }),
    );
    void ipc
      .listPendingPermissions()
      .then((views) => usePermissionPromptStore.getState().hydrate(views))
      .catch(() => {
        // 主进程尚未就绪 / 没有请求：忽略
      });

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [_onEvent, _onDone, _onAborted, _onTaskUpdated]);
}
