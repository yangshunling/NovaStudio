/**
 * 应用生命周期状态机
 *
 * 退出链路原来散落在 main/index.ts 的一串布尔量里：
 * `quitting` / `cleanupFinished` / `backgroundStopped` / `databaseClosed`，
 * 每个新加入的后台资源都要记得去改 `stopBackgroundTasks()`，漏掉一个就会
 * 留下孤儿进程或让进程退不掉。
 *
 * 这里把「启动完成 → 退出清理 → 已退出」收敛成显式状态机，并允许各模块
 * **注册自己的释放步骤**：
 *   - 新增后台资源时只注册一步，不再改退出主流程；
 *   - 每一步单独限时，任何一步卡住都不会拖死整个退出；
 *   - 重复触发由状态机幂等吸收，不再依赖多个布尔量的组合。
 */

import { errorMessage } from "../../shared/error";

/** 应用阶段：只有 ready 才能正常服务；disposing 之后不再接受新工作 */
export type AppPhase = "starting" | "ready" | "disposing" | "disposed";

export interface ShutdownStep {
  /** 日志与排障用的步骤名，例如 "agents" / "database" */
  name: string;
  /** 数值小的先执行；数据库必须排在最后 */
  order: number;
  /** 同步或异步释放；抛错/超时都不阻断后续步骤 */
  run: () => void | Promise<void>;
  /** 单步上限，默认 6s */
  timeoutMs?: number;
}

/** 单步默认上限：短于全局看门狗，保证日志能指出是哪一步慢 */
const DEFAULT_STEP_TIMEOUT_MS = 6_000;

export interface AppLifecycle {
  readonly phase: AppPhase;
  isStarting(): boolean;
  isReady(): boolean;
  /** 清理已开始或已完成：窗口关闭、重建窗口都要让路 */
  isClosing(): boolean;
  markReady(): void;
  register(step: ShutdownStep): void;
  /** 执行退出清理。幂等，永不 reject */
  dispose(reason: string): Promise<void>;
}

function withTimeout(
  run: () => void | Promise<void>,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`超过 ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve()
      .then(run)
      .then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
  });
}

/**
 * 创建一个独立的状态机实例。
 *
 * 日志器由调用方注入：本模块不依赖 Electron，可以在单测里直接跑。
 * 生产单例见 lifecycle/index.ts。
 */
export function createLifecycle(
  log: (message: string) => void = () => {},
): AppLifecycle {
  let phase: AppPhase = "starting";
  const steps: ShutdownStep[] = [];
  let disposePromise: Promise<void> | null = null;

  return {
    get phase(): AppPhase {
      return phase;
    },

    isStarting(): boolean {
      return phase === "starting";
    },

    isReady(): boolean {
      return phase === "ready";
    },

    isClosing(): boolean {
      return phase === "disposing" || phase === "disposed";
    },

    /** 启动流程末尾调用。重复调用无副作用 */
    markReady(): void {
      if (phase !== "starting") return;
      phase = "ready";
      log("应用启动完成");
    },

    /**
     * 注册一个退出步骤。
     *
     * 在资源创建处注册，而不是统一堆在退出主流程里：资源与释放逻辑
     * 放在同一个模块，才不会出现「新增子进程时忘了退出要收」。
     */
    register(step: ShutdownStep): void {
      steps.push(step);
    },

    /**
     * 执行退出清理。幂等：并发/重复调用共享同一次清理。
     * 永不 reject —— 退出流程不能因为某个收尾失败而中断。
     */
    dispose(reason: string): Promise<void> {
      if (disposePromise) return disposePromise;

      disposePromise = (async () => {
        phase = "disposing";
        const startedAt = Date.now();
        const ordered = [...steps].sort((a, b) => a.order - b.order);
        log(`开始退出清理（${reason}），共 ${ordered.length} 步`);

        for (const step of ordered) {
          const stepStartedAt = Date.now();
          try {
            await withTimeout(step.run, step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
          } catch (err) {
            // 单步失败/超时只记录，继续后面的步骤（尤其是关库）
            log(
              `退出步骤 ${step.name} 失败或超时（${Date.now() - stepStartedAt}ms）：${errorMessage(err)}`,
            );
          }
        }

        phase = "disposed";
        log(`退出清理完成，用时 ${Date.now() - startedAt}ms`);
      })();

      return disposePromise;
    },
  };
}

