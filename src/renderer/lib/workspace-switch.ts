/**
 * 切换当前会话的工作区（绑定 / 解绑）
 *
 * 只在会话草稿状态可用：首条消息发出后工作区随会话固定，
 * 与数字员工 / Agent 的锁定规则一致。
 *
 * 输入区的 `#` 快捷切换与工作区选择器共用这一份逻辑，
 * 避免两处的拦截文案与锁定判定各自漂移。
 */

import { useChatStore } from "../stores/chat";
import { toast } from "../stores/toast";
import { errorMessage } from "@shared/error";

/** 运行中切换被拒时给用户看的原因（选择器与 `#` 快捷切换共用） */
export const WORKSPACE_RUNNING_HINT =
  "当前会话正在运行，请等本轮结束后再切换工作区";

/** 会话已开始：工作区随会话固定，换目录只能新建会话 */
export const WORKSPACE_LOCKED_HINT =
  "会话已开始，工作区不可更换；请新建会话后重新选择";

/** 当前会话是否因为正在运行而禁止切换工作区 */
export function isWorkspaceSwitchBlocked(): boolean {
  const state = useChatStore.getState();
  const sessionId = state.currentSessionId;
  return !!sessionId && !!state.streamingBySession[sessionId];
}

/** 当前会话是否已开始（存在会话即已锁定工作区，与数字员工一致） */
export function isWorkspaceLocked(): boolean {
  return useChatStore.getState().currentSessionId !== null;
}

export async function switchWorkspace(projectId: string | null): Promise<void> {
  const state = useChatStore.getState();
  if (projectId === state.currentProjectId) return;

  /*
   * 会话一旦创建就锁定工作区（与员工、Agent 一致）：
   * session:setProject 会清空 agentSessionId，换目录等于重开上下文，
   * 与其让用户确认后丢上下文，不如直接要求新建会话。
   */
  if (isWorkspaceLocked()) {
    toast.error(WORKSPACE_LOCKED_HINT, 5000);
    return;
  }

  /*
   * 兜底：渲染层与主进程状态短暂不一致时，仍可能走到这里。
   * 运行中切换会让正在跑的进程继续持有旧目录，必须拦下。
   */
  if (isWorkspaceSwitchBlocked()) {
    toast.error(WORKSPACE_RUNNING_HINT, 5000);
    return;
  }

  try {
    await state.bindProject(projectId);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}
