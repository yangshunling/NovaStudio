/**
 * 切换当前会话的数字员工
 *
 * 输入框旁的「指定员工」与 `@` 弹窗里的「数字员工」共用这一份逻辑，
 * 避免两处对「运行中不可切换」的判定与提示文案各自漂移。
 *
 * 会话正在运行时不接受切换：本轮进程已经按旧员工启动了，
 * 此时改绑定只会让下一轮与当前轮不一致，用户却看不到任何即时反馈。
 */

import { useChatStore } from "../stores/chat";
import { toast } from "../stores/toast";

/** 运行中切换被拒时给用户看的原因 */
export const EMPLOYEE_RUNNING_HINT =
  "当前会话正在运行，请等本轮结束后再切换数字员工";

/** 会话已发出第一条消息：员工随会话固定，换人只能新建会话 */
export const EMPLOYEE_LOCKED_HINT =
  "会话已开始，数字员工不可更换；请新建会话后重新选择";

/** 当前会话是否因为正在运行而禁止切换数字员工 */
export function isEmployeeSwitchBlocked(): boolean {
  const state = useChatStore.getState();
  const sessionId = state.currentSessionId;
  return !!sessionId && !!state.streamingBySession[sessionId];
}

/** 当前会话是否已开始（存在会话即已锁定员工） */
export function isEmployeeLocked(): boolean {
  return useChatStore.getState().currentSessionId !== null;
}

/**
 * 写入会话的员工绑定。
 *
 * 会话一旦创建就锁定员工（与 Agent 一致）；运行中的拦截仍然保留，
 * 用于覆盖主进程状态与渲染层短暂不一致的窗口。
 * 返回是否真的完成了切换。
 */
export function chooseEmployee(id: string | null): boolean {
  if (isEmployeeLocked()) {
    toast.error(EMPLOYEE_LOCKED_HINT, 5000);
    return false;
  }
  if (isEmployeeSwitchBlocked()) {
    toast.error(EMPLOYEE_RUNNING_HINT, 5000);
    return false;
  }
  useChatStore.getState().selectEmployee(id);
  return true;
}
