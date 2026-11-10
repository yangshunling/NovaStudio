/**
 * 切换当前会话的工作区（绑定 / 解绑）
 *
 * 已产生消息的会话切换工作区会重置 Agent 上下文，因此先确认；
 * 新会话草稿直接记录选择，不弹确认。
 *
 * 输入区的 `#` 快捷切换与工作区选择器共用这一份逻辑，
 * 避免两处的确认文案、上下文判定各自漂移。
 */

import { useChatStore } from "../stores/chat";
import { confirmDialog } from "../stores/confirm";
import { toast } from "../stores/toast";
import { errorMessage } from "@shared/error";

/** 运行中切换被拒时给用户看的原因（选择器与 `#` 快捷切换共用） */
export const WORKSPACE_RUNNING_HINT =
  "当前会话正在运行，请等本轮结束后再切换工作区";

/** 当前会话是否因为正在运行而禁止切换工作区 */
export function isWorkspaceSwitchBlocked(): boolean {
  const state = useChatStore.getState();
  const sessionId = state.currentSessionId;
  return !!sessionId && !!state.streamingBySession[sessionId];
}

export async function switchWorkspace(projectId: string | null): Promise<void> {
  const state = useChatStore.getState();
  if (projectId === state.currentProjectId) return;

  const sessionId = state.currentSessionId;

  /*
   * 运行中不能切换：session:setProject 会清空 agentSessionId，而正在跑的
   * 进程仍持有旧目录。必须在二次确认之前拦截 —— 否则用户点了「切换工作区」
   * 才收到一条 2.4 秒就消失的失败提示，看起来就是「选了却没生效」。
   */
  if (isWorkspaceSwitchBlocked()) {
    toast.error(WORKSPACE_RUNNING_HINT, 5000);
    return;
  }

  const session = state.sessions.find((item) => item.id === sessionId);
  // 视图里的消息数比 sessions.messageCount 更新，优先用它判断上下文
  const messageCount = sessionId
    ? (state.messagesBySession[sessionId]?.length ?? 0)
    : 0;
  const hasContext =
    messageCount > 0 || (session?.messageCount ?? 0) > 0;

  if (sessionId && hasContext) {
    const target = projectId
      ? (state.projects.find((item) => item.id === projectId)?.name ?? "所选工作区")
      : "默认目录";
    const confirmed = await confirmDialog({
      title: `将当前会话的工作区切换到「${target}」？`,
      message: [
        "会话已经产生消息，切换工作区会重置 Agent 的上下文（开启新对话记忆）。",
        "本地历史消息仍会保留，此操作不会删除任何记录。",
      ].join("\n"),
      confirmLabel: "切换工作区",
    });
    if (!confirmed) return;
  }

  try {
    await state.bindProject(projectId);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}
