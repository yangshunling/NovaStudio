/**
 * 自动化任务 IPC：列表 / 创建 / 删除 / 重试 / 停止
 *
 * 任务的拾取与执行在 ../automation/scheduler.ts，本文件只处理用户操作。
 * 停止需要落到调度器上（它才知道任务是哪个进程、如何中断）。
 */

import type { AgentService } from "../../engine/agent-service";
import type { AutomationScheduler } from "../../automation/scheduler";
import * as db from "../../db/sqlite";
import { push } from "../push";
import { handle } from "../register";

export function registerAutomationHandlers(
  service: AgentService,
  scheduler: AutomationScheduler,
): void {
  handle("automation:list", () => db.listAutomationTasks());

  handle("automation:create", ({ prompt, projectId, agentId }) => {
    const task = db.createAutomationTask(prompt, projectId, agentId);
    push("automation:updated", task);
    return task;
  });

  handle("automation:delete", ({ id }) => {
    // 运行中的任务不允许删除
    if (db.getAutomationTask(id)?.status === "running") return false;
    db.deleteAutomationTask(id);
    return true;
  });

  handle("automation:retry", ({ id }) => {
    const task = db.getAutomationTask(id);
    if (!task) return false;
    // 只有已完成 / 失败的任务可以重试
    if (task.status === "running" || task.status === "pending") return false;

    // 清理旧会话（CLI 侧数据 + 索引行），避免重试产生孤儿会话
    if (task.sessionId) {
      service.releaseSession(task.sessionId);
      db.deleteSession(task.sessionId);
    }

    db.updateAutomationTask(id, {
      status: "pending",
      sessionId: null,
      startedAt: null,
      completedAt: null,
      error: null,
    });

    // 立即拾取：有空位时任务直接回到 running（停留在「执行中」列，不闪回待执行）；
    // 并发已满则先排队，等待下一个轮询周期
    scheduler.kick();

    const updated = db.getAutomationTask(id);
    if (updated) push("automation:updated", updated);
    return true;
  });

  // 停止执行中的任务：中断其会话并落 failed（回到待执行列，可重试）
  handle("automation:stop", ({ id }) => scheduler.stopTask(id));
}
