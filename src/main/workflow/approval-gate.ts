/**
 * 人工审核门 —— 节点产出后的等待 / 决定 / 超时
 *
 * 从工作流运行器里独立出来：审核门的语义（谁在等、超时算中断还是驳回、
 * 取消时怎样唤醒）与 DAG 调度、节点执行互不相干，混在 runner 闭包里
 * 既难单测，也容易被调度逻辑的改动波及。
 *
 * 状态不放在模块里：每次运行把自己的 approvals 表传进来，由调用方掌握
 * 生命周期（运行结束即整表丢弃）。
 */

/**
 * 人工审核最长等待时间。
 * 超时只是「没人确认」，不是「人工驳回」：运行按中断收尾并保留产物，
 * 用户回来后可以继续执行；否则一个被遗忘的审批会把工作区永久锁住。
 */
export const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

export interface ApprovalDecision {
  /**
   * - approve / reject：最终决定
   * - revise：要求修改，复用当前会话再执行一轮
   * - cancel：运行被终止
   * - timeout：等待超时，既不是通过也不是人工驳回
   */
  action: "approve" | "reject" | "revise" | "cancel" | "timeout";
  note: string;
}

export interface ApprovalSlot {
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

/** nodeRunId → 等待中的审批 */
export type ApprovalMap = Map<string, ApprovalSlot>;

export interface ApprovalGate {
  /** 等待某个节点的审核结果；超时返回 timeout，不抛错 */
  wait(approvals: ApprovalMap, runId: string, nodeRunId: string): Promise<ApprovalDecision>;
  /** 用户点击通过 / 驳回 / 要求修改；未命中返回 false */
  settle(
    approvals: ApprovalMap,
    nodeRunId: string,
    action: "approve" | "reject" | "revise",
    note?: string,
  ): boolean;
  /** 运行被取消：唤醒所有等待者并清空表 */
  cancelAll(approvals: ApprovalMap): void;
}

/**
 * @param log 审核超时时的提示写入口（runner 用它发一条 warning 事件）
 */
export function createApprovalGate(
  log: (runId: string, nodeRunId: string, message: string) => void,
): ApprovalGate {
  return {
    wait(approvals, runId, nodeRunId) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!approvals.has(nodeRunId)) return;
          approvals.delete(nodeRunId);
          const minutes = Math.round(APPROVAL_TIMEOUT_MS / 60000);
          log(
            runId,
            nodeRunId,
            `等待人工审核超过 ${minutes} 分钟，本次运行按中断处理，可稍后继续执行`,
          );
          // 超时只是没人确认：交给调用方按「中断」收尾，不能写成人工驳回
          resolve({ action: "timeout", note: `超过 ${minutes} 分钟未确认` });
        }, APPROVAL_TIMEOUT_MS);

        approvals.set(nodeRunId, { resolve, timer });
      });
    },

    settle(approvals, nodeRunId, action, note) {
      const entry = approvals.get(nodeRunId);
      if (!entry) return false;
      approvals.delete(nodeRunId);
      clearTimeout(entry.timer);
      entry.resolve({ action, note: note?.trim() ?? "" });
      return true;
    },

    cancelAll(approvals) {
      for (const entry of approvals.values()) {
        clearTimeout(entry.timer);
        entry.resolve({ action: "cancel", note: "" });
      }
      approvals.clear();
    },
  };
}
