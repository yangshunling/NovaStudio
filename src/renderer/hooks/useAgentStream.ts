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

export function useAgentStream(): void {
  const _onEvent = useChatStore((s) => s._onEvent);
  const _onDone = useChatStore((s) => s._onDone);
  // 用 selector 取 action，保证依赖稳定且绕开 getState 的非响应式调用
  const _onTaskUpdated = useAutomationStore((s) => s._onTaskUpdated);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    // 事件带 sessionId，按会话路由到对应消息桶（多会话并发）
    unsubs.push(ipc.on.agentEvent((payload) => _onEvent(payload)));
    unsubs.push(ipc.on.agentDone((data) => _onDone(data)));
    // 收到 Agent 检测结果推送后刷新 store
    unsubs.push(
      ipc.on.agentsDetected((agents) => {
        useChatStore.setState({ agents });
      }),
    );
    unsubs.push(ipc.on.automationUpdated((task) => _onTaskUpdated(task)));

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [_onEvent, _onDone, _onTaskUpdated]);
}
