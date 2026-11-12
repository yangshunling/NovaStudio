/**
 * 切换当前会话的数字员工
 *
 * 输入框旁的「指定员工」与 `@` 弹窗里的「数字员工」共用这一份逻辑。
 * 员工不随会话锁定，任何时候都可以切换：切换只改变「下一条消息由谁回答」，
 * 会话本身与 CLI 上下文保持不变。
 *
 * 运行中同样允许切换。本轮进程在启动时就固定了 CLAUDE_CONFIG_DIR、系统提示词、
 * MCP 与技能，改绑定不会影响它；新选择从下一轮开始生效（主进程在运行中只落库，
 * 不提前物化运行时，避免重写正在使用的 home）。
 */

import { errorMessage } from "@shared/error";
import { useChatStore } from "../stores/chat";
import { toast } from "../stores/toast";

/**
 * 默认回答者（通用助手）。
 *
 * 它不是一个数字员工，而是「不绑定员工」这一状态：由 Agent 的全局配置作答。
 * 无论有没有数字员工都必须存在，因此名称与副标题集中在这里，供选择器
 * 与 `@` 弹窗共用，避免两处文案不一致。
 */
export const DEFAULT_ASSISTANT = {
  name: "通用助手",
  detail: "默认对话 · Agent 全局配置",
} as const;

/** 运行中切换时给用户看的说明：本轮不会变，下一轮生效 */
export const EMPLOYEE_DEFERRED_HINT =
  "已切换回答者，本轮运行结束后生效";

/** 当前会话是否正在运行（仅用于给「下一轮生效」的提示） */
export function isSessionStreaming(): boolean {
  const state = useChatStore.getState();
  const sessionId = state.currentSessionId;
  return !!sessionId && !!state.streamingBySession[sessionId];
}

/** 当前回答者：优先乐观快照，其次会话记录，最后是新会话草稿的选择 */
function currentEmployeeId(): string | null {
  const state = useChatStore.getState();
  const sessionId = state.currentSessionId;
  if (!sessionId) return state.selectedEmployeeId;
  if (sessionId in state.employeeIdBySession) {
    return state.employeeIdBySession[sessionId] ?? null;
  }
  return (
    state.sessions.find((session) => session.id === sessionId)?.employeeId ??
    null
  );
}

/**
 * 写入当前会话（或新会话草稿）的员工选择。
 *
 * 已有会话会同步到主进程；新会话只更新内存里的默认选择。
 * 运行中也可以切换，只是本轮进程已按旧配置启动，新选择从下一轮生效。
 * 返回是否真的完成了切换。
 */
export async function chooseEmployee(id: string | null): Promise<boolean> {
  const previous = currentEmployeeId();
  try {
    await useChatStore.getState().selectEmployee(id);
    /*
     * 运行中切换不是没生效，而是下一轮才生效；没有这句提示用户会以为点空了。
     * 重选当前员工（no-op）不提示，避免「明明没换也弹出已切换」。
     */
    if (previous !== id && isSessionStreaming()) {
      toast.info(EMPLOYEE_DEFERRED_HINT, 3000);
    }
    return true;
  } catch (err) {
    toast.error(errorMessage(err), 5000);
    return false;
  }
}
