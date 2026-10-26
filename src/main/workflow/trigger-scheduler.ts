/**
 * 工作流触发器调度器
 *
 * 每 15 秒扫一次启用的触发器，到点后启动它绑定的工作流。
 *
 * 约定：
 * - 触发时间只按本机时间解释；应用重启后一律「从现在重新计算下一次」，
 *   不补跑关闭期间错过的时刻 —— 否则开机瞬间可能突然连跑好几次。
 * - 先推进下次触发时间、再启动工作流：即使启动过程抛错，也不会在同一分钟
 *   被重复触发。
 * - 运行器限制「同一工作区同时只能有一条工作流在跑」。被占用的工作流进入
 *   待启动队列，等下一个轮询周期重试；超过 30 分钟仍未空出则放弃本次触发。
 * - 单个工作流自身已在运行时，直接跳过本次触发，不排队补跑。
 */

import * as db from "../db/sqlite";
import { nextTriggerFireAt } from "../../shared/trigger-schedule";
import type { WorkflowTrigger } from "../../shared/types";
import type { WorkflowRunner } from "./runner";

/** 扫描周期（毫秒） */
const POLL_INTERVAL_MS = 15_000;
/** 工作区被占用时的最大重试次数：15s × 120 ≈ 30 分钟 */
const MAX_BUSY_RETRIES = 120;

export interface TriggerScheduler {
  /** 启动轮询；重复调用无副作用 */
  start(): void;
  /** 停止轮询（应用退出时调用） */
  stop(): void;
}

export interface TriggerSchedulerDeps {
  runner: WorkflowRunner;
  /** 状态变化推送给渲染进程；窗口未就绪时由 push 层静默丢弃 */
  emit: (trigger: WorkflowTrigger) => void;
}

interface PendingWorkflow {
  triggerId: string;
  /** 因工作区被占用而重试的次数 */
  attempts: number;
}

export function createTriggerScheduler(
  deps: TriggerSchedulerDeps,
): TriggerScheduler {
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  /** workflowId → 等待启动的工作流 */
  const pending = new Map<string, PendingWorkflow>();

  /** 写入运行状态并推送，返回最新记录 */
  function patchRuntime(
    trigger: WorkflowTrigger,
    patch: { lastFiredAt?: number; nextFireAt?: number | null },
  ): void {
    const updated = db.updateWorkflowTriggerRuntime(trigger.id, patch);
    if (updated) deps.emit(updated);
  }

  /**
   * 到点触发：先推进时间，再把绑定的工作流放进队列。
   * 同步完成，保证同一轮扫描里不会被再次判定为到点。
   */
  function fire(trigger: WorkflowTrigger, now: number): void {
    patchRuntime(trigger, {
      lastFiredAt: now,
      nextFireAt: nextTriggerFireAt(trigger.schedule, now),
    });

    for (const workflowId of db.listWorkflowIdsForTrigger(trigger.id)) {
      // 该工作流自己正在跑：本次跳过，不排队补跑
      if (deps.runner.hasActiveRunForWorkflow(workflowId)) continue;
      if (!pending.has(workflowId)) {
        pending.set(workflowId, { triggerId: trigger.id, attempts: 0 });
      }
    }
  }

  /**
   * 尝试启动队列里的工作流。
   * 运行器是异步校验 Agent 安装的，逐个 await 启动，
   * 避免同一工作区的两条工作流同时通过「空闲」检查。
   */
  async function drain(): Promise<void> {
    if (pending.size === 0) return;

    for (const [workflowId, item] of [...pending]) {
      if (!pending.has(workflowId)) continue;
      try {
        await deps.runner.start(workflowId);
        pending.delete(workflowId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const workspaceBusy = message.includes("已有运行中的工作流");

        if (workspaceBusy) {
          item.attempts += 1;
          if (item.attempts < MAX_BUSY_RETRIES) continue;
          console.error(
            `[trigger] 工作流 ${workflowId} 等待工作区空闲超时，本次触发已放弃`,
          );
        } else {
          console.error(
            `[trigger] 触发器 ${item.triggerId} 启动工作流 ${workflowId} 失败：${message}`,
          );
        }
        pending.delete(workflowId);
      }
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      // 先把上一轮排队的工作流送出去（工作区可能已经空闲）
      await drain();

      const now = Date.now();
      for (const trigger of db.listWorkflowTriggers()) {
        if (!trigger.enabled) continue;

        // 旧数据 / 异常退出可能缺下次时间：补一个，不补跑
        if (trigger.nextFireAt === null) {
          patchRuntime(trigger, {
            nextFireAt: nextTriggerFireAt(trigger.schedule, now),
          });
          continue;
        }

        if (trigger.nextFireAt > now) continue;
        fire(trigger, now);
      }

      await drain();
    } finally {
      ticking = false;
    }
  }

  return {
    start(): void {
      if (timer) return;

      // 重启后从「现在」重新计算，不追补关闭期间错过的时刻
      const now = Date.now();
      for (const trigger of db.listWorkflowTriggers()) {
        const next = trigger.enabled
          ? nextTriggerFireAt(trigger.schedule, now)
          : null;
        if (next !== trigger.nextFireAt) {
          patchRuntime(trigger, { nextFireAt: next });
        }
      }

      const arm = () => {
        timer = setTimeout(() => {
          void tick()
            // 单轮扫描失败不能让整个调度器停摆（例如数据库短暂繁忙）
            .catch((err) => {
              console.error(`[trigger] 扫描触发器失败：${String(err)}`);
            })
            .finally(() => {
              if (timer) arm();
            });
        }, POLL_INTERVAL_MS);
      };
      arm();
    },

    stop(): void {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
