/**
 * 应用退出编排
 *
 * 顺序是硬约束：
 *   1. 先解决「有没有未保存改动」——用户可能取消，此时**不能**开始清理，
 *      否则会出现「任务已停、库已关，但窗口还在」的半退出状态；
 *   2. 再按注册顺序执行清理（agents 落库 → 关库）；
 *   3. 最后 app.quit()，before-quit 因状态已是 disposed 而直接放行。
 *
 * 关窗（点 X）不走这里：窗口关闭由 close 守卫决定，窗口真正销毁后
 * window-all-closed 会触发 app.quit()，再进入本流程（此时已无窗口、无未保存）。
 */

import { app } from "electron";
import { closeDatabase } from "../db/connection";
import { getMainWindow } from "../ipc/push";
import { logLifecycle } from "../utils/lifecycle-log";
import { appLifecycle } from "./index";
import { confirmUnsaved } from "./unsaved";

/** 清理完成后的强制退出兜底：防止卡在 will-quit */
const FORCE_EXIT_MS = 3_000;

let quitInFlight: Promise<void> | null = null;

/** 安装 before-quit / will-quit 处理器（进程生命周期内只需一次） */
export function installQuitHandler(): void {
  app.on("before-quit", (event) => {
    // 清理已完成：放行，让 Electron 继续关闭窗口并退出
    if (appLifecycle.phase === "disposed") return;

    // 清理进行中：继续阻止，等 requestQuit 完成后的 app.quit()
    event.preventDefault();
    if (appLifecycle.isClosing()) return;

    void requestQuit("before-quit");
  });

  app.on("will-quit", () => {
    // 双保险：lifecycle 的最后一步已经关库，这里幂等兜底
    closeDatabase();
  });
}

/**
 * 请求退出：先确认未保存改动，再执行清理。
 *
 * 幂等：清理开始后重复调用共享同一次流程；用户取消后允许下次重新发起。
 */
export function requestQuit(reason: string): Promise<void> {
  if (quitInFlight) return quitInFlight;

  const run = async (): Promise<void> => {
    const proceed = await confirmUnsaved(getMainWindow());
    if (!proceed) {
      logLifecycle(`退出已取消（${reason}）`);
      return;
    }

    await appLifecycle.dispose(reason);
    app.quit();

    setTimeout(() => {
      logLifecycle("force exit：清理完成后进程仍未退出");
      app.exit(0);
    }, FORCE_EXIT_MS).unref?.();
  };

  quitInFlight = run().finally(() => {
    if (!appLifecycle.isClosing()) quitInFlight = null;
  });

  return quitInFlight;
}
