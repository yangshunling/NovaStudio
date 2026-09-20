/**
 * 自动化任务轮询执行器
 *
 * 定时检查 pending 任务，按「并发上限」并行拾取执行（默认 3，可在设置-通用里改），
 * 有空位就继续拾取，直到没有 pending 任务或跑满并发。
 *
 * 执行流程：创建会话 → 记录用户消息 → AgentService.run → 按退出码更新任务状态。
 * 复用对话基础设施，因此事件天然按 sessionId 路由，详情页可实时查看。
 *
 * 关键约定：任务一旦被拾取就必须离开 running —— 成功 → completed，
 * 失败 / 超时 / 启动失败 / 用户停止 → failed。failed 会停留在「执行中」列，
 * 等待用户手动重试；只有 pending 会被自动拾取，因此不会无限重跑。
 * 只有这样才能避免卡片在「执行中」列无限转圈又无法处理。
 *
 * 状态全部收在 createScheduler 的闭包里（与 createAgentService 同一风格），
 * 不用模块级变量 —— 生命周期由调用方通过 start / stop 掌握。
 */

import type { AutomationTask } from "../../shared/types";
import type { AgentService } from "../engine/agent-service";
import * as db from "../db/sqlite";
import { flushEvents, push } from "../ipc/push";

/** 轮询周期的兜底值（毫秒）：设置缺失或非法时使用 */
const DEFAULT_POLL_INTERVAL_MS = 30000;
/** 轮询周期的硬下限（毫秒）：防止设置过短造成性能损耗 */
const MIN_POLL_INTERVAL_MS = 5000;
/** 并发上限的兜底值：设置缺失或非法时使用 */
const DEFAULT_CONCURRENCY = 3;
/** 并发上限的硬上限：防止设置被写入异常值时把机器打爆 */
const MAX_CONCURRENCY = 10;
/** 用户手动停止时写入的错误信息（与执行失败区分开） */
const STOPPED_ERROR = "已手动停止";

export interface AutomationScheduler {
  /** 启动轮询；重复调用无副作用 */
  start(): void;
  /** 停止轮询并清理定时器（应用退出时调用） */
  stop(): void;
  /** 手动停止一个执行中的任务；返回是否命中（未命中说明任务不在执行中） */
  stopTask(taskId: string): boolean;
  /** 立即执行一次拾取（手动重试后调用，省去等待下一个轮询周期） */
  kick(): void;
}

/** 更新任务状态并推送变更 */
function patchTask(id: string, patch: Parameters<typeof db.updateAutomationTask>[1]): void {
  db.updateAutomationTask(id, patch);
  const task = db.getAutomationTask(id);
  if (task) push("automation:updated", task);
}

/** 读取轮询周期：来自设置（秒），非法值回退默认，并夹在硬下限内 */
function pollIntervalMs(): number {
  const raw = db.getSetting("automationPollIntervalSec");
  const sec = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(sec) || sec < 1) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(Math.floor(sec) * 1000, MIN_POLL_INTERVAL_MS);
}

/** 读取并发上限：来自设置，非法值回退默认，并夹在硬上限内 */
function concurrencyLimit(): number {
  const raw = db.getSetting("automationConcurrency");
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(Math.floor(n), MAX_CONCURRENCY);
}

/**
 * 清理上一个进程遗留的 running 任务。
 * 子进程随应用退出一同结束，所以启动瞬间不可能真的有任务在跑；
 * 不清理的话这些任务会永远停在「执行中」列转圈（既跑不了也停不下来）。
 */
function recoverStuckTasks(): void {
  for (const task of db.listAutomationTasks()) {
    if (task.status !== "running") continue;
    patchTask(task.id, {
      status: "failed",
      error: "应用已退出，执行被中断",
      completedAt: Date.now(),
    });
  }
}

/** 基于给定 AgentService 创建一个轮询执行器 */
export function createScheduler(agentService: AgentService): AutomationScheduler {
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  /** 正在执行的任务 id（并发上限据此计算剩余空位） */
  const running = new Set<string>();
  /** 已被用户请求停止的任务 id —— 防止 run 结束后覆写用户已看到的停止状态 */
  const stopping = new Set<string>();

  function tick(): void {
    if (ticking) return;
    ticking = true;
    try {
      const slots = concurrencyLimit() - running.size;
      if (slots <= 0) return;

      // listAutomationTasks 是倒序（最新在前），最早的 pending 在末尾，故反转
      const pending = db
        .listAutomationTasks()
        .filter((t) => t.status === "pending")
        .reverse();

      for (const task of pending.slice(0, slots)) void runTask(task);
    } finally {
      ticking = false;
    }
  }

  /** 认领任务并执行：负责运行集的进出与异常兜底（runTask 同步登记，避免重入重复拾取） */
  async function runTask(task: AutomationTask): Promise<void> {
    running.add(task.id);
    try {
      await execute(task);
    } catch (err) {
      // 任何未预期的异常都必须落到 failed，绝不能把任务留在 running
      patchTask(task.id, {
        status: "failed",
        error: String(err),
        completedAt: Date.now(),
      });
    } finally {
      running.delete(task.id);
      stopping.delete(task.id);
    }
  }

  async function execute(task: AutomationTask): Promise<void> {
    patchTask(task.id, { status: "running", startedAt: Date.now() });

    const project = db.getProject(task.projectId);
    if (!project) throw new Error("项目不存在");

    const cwd = agentService.resolveCwd(project.cwd, db.getSetting("defaultCwd"));

    // 创建会话（复用对话基础设施），并让详情抽屉能立刻看到原始指令
    const session = db.createSession(
      task.agentId,
      task.projectId,
      cwd,
      task.prompt.slice(0, 40),
    );
    patchTask(task.id, { sessionId: session.id });
    db.touchSession(session.id, { countDelta: 1 });

    const outcome = await agentService.run({
      sessionId: session.id,
      prompt: task.prompt,
      cwd,
    });
    flushEvents();

    // 用户已手动停止：状态在 stopTask 里已落库，这里不再覆写
    if (stopping.has(task.id)) return;

    if (!outcome.ok) throw new Error(outcome.error ?? "运行失败");

    // 被动中断（非用户发起）同样属于失败，不能留在 running
    if (outcome.aborted) {
      patchTask(task.id, { status: "failed", error: STOPPED_ERROR, completedAt: Date.now() });
      return;
    }

    db.touchSession(session.id, { countDelta: 1 });
    push("agent:done", {
      sessionId: session.id,
      exitCode: outcome.exitCode,
      duration: outcome.duration,
    });

    patchTask(
      task.id,
      outcome.exitCode === 0
        ? { status: "completed", completedAt: Date.now() }
        : { status: "failed", error: `退出码 ${outcome.exitCode}`, completedAt: Date.now() },
    );
  }

  return {
    start(): void {
      if (timer) return;
      // 首次启动：先收拾上一个进程留下的 running 任务，再开始轮询
      recoverStuckTasks();
      // 用 setTimeout 逐次重新武装，使轮询周期设置在下一周期即生效
      const arm = () => {
        timer = setTimeout(() => {
          tick();
          if (timer) arm();
        }, pollIntervalMs());
      };
      arm();
    },

    stop(): void {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    },

    kick(): void {
      tick();
    },

    stopTask(taskId: string): boolean {
      const task = db.getAutomationTask(taskId);
      if (!task || task.status !== "running") return false;

      // 先登记「用户停止」：即使此刻进程刚结束，也不会被覆写成完成
      stopping.add(taskId);
      if (task.sessionId) agentService.abort(task.sessionId);
      patchTask(taskId, {
        status: "failed",
        error: STOPPED_ERROR,
        completedAt: Date.now(),
      });
      return true;
    },
  };
}
