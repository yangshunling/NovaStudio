/**
 * 切换当前会话的工作区（绑定 / 解绑）
 *
 * 会话开始后仍可切换，但换目录等于开启新的 Agent 上下文：
 * 旧对话会保留在会话里，只是不再参与后续上下文。因此已有对话时
 * 先让用户确认，切换成功后主进程会插入一条 system 分隔提示。
 *
 * 输入框旁的工作区选择器统一走这一份逻辑，
 * 确认文案与运行中拦截不会在别处漂移。
 */

import { confirmDialog } from "../stores/confirm";
import { useChatStore } from "../stores/chat";
import { toast } from "../stores/toast";
import { errorMessage } from "@shared/error";

/** 运行中切换被拒时给用户看的原因 */
export const WORKSPACE_RUNNING_HINT =
  "当前会话正在运行，请等本轮结束后再切换工作区";

/** 当前会话是否因为正在运行而禁止切换工作区 */
export function isWorkspaceSwitchBlocked(): boolean {
  const state = useChatStore.getState();
  const sessionId = state.currentSessionId;
  return !!sessionId && !!state.streamingBySession[sessionId];
}

/** 当前会话是否已有对话上下文（切换目录会丢失它们） */
export function hasWorkspaceContext(): boolean {
  const state = useChatStore.getState();
  const sessionId = state.currentSessionId;
  if (!sessionId) return false;

  const messages = state.messagesBySession[sessionId] ?? [];
  if (messages.length > 0) return true;

  const session = state.sessions.find((item) => item.id === sessionId);
  return Boolean(session?.agentSessionId);
}

/**
 * 切换结果：
 * - switched：已切换
 * - unchanged：目标就是当前工作区，没有动作
 * - cancelled：用户取消确认
 * - blocked：运行中或切换失败
 */
export type WorkspaceSwitchResult =
  | "switched"
  | "unchanged"
  | "cancelled"
  | "blocked";

export async function switchWorkspace(
  projectId: string | null,
): Promise<WorkspaceSwitchResult> {
  const state = useChatStore.getState();
  if (projectId === state.currentProjectId) return "unchanged";

  /*
   * 运行中切换会让正在跑的进程继续持有旧目录，必须拦下。
   * 渲染层先拦一次，主进程 session:setProject 还会兜底。
   */
  if (isWorkspaceSwitchBlocked()) {
    toast.error(WORKSPACE_RUNNING_HINT, 5000);
    return "blocked";
  }

  /*
   * 会话已有对话时，换目录等于重开上下文：
   * 明确告诉用户旧对话不会消失、但不会再被记住。
   */
  if (hasWorkspaceContext()) {
    const confirmed = await confirmDialog({
      title: "切换工作区？",
      message:
        "切换后 AI 将开始新的对话上下文，之前聊过的内容不会再被记住。\n旧对话仍保留在会话中，并会标记为不参与当前上下文。",
      confirmLabel: "切换并重置上下文",
      tone: "danger",
    });
    if (!confirmed) return "cancelled";
  }

  try {
    await state.bindProject(projectId);
    return "switched";
  } catch (err) {
    toast.error(errorMessage(err));
    return "blocked";
  }
}
