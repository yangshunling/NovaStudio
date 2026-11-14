/**
 * 窗口 / 进程生命周期的轻量日志
 *
 * 退出链路的问题在客户现场几乎无法复现：窗口没关、进程还在，但没有任何
 * 输出可看。这里只记录**异常与关键决策**（beforeunload 被拦、退出清理
 * 超时、强制退出），正常关闭不写盘，避免无意义的 IO。
 *
 * 文件落在 userData/logs/lifecycle.log，超过上限直接清空重写：
 * 排障只关心最近一次退出，不需要轮转归档。
 */

import { app } from "electron";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const MAX_BYTES = 256 * 1024;

export function logLifecycle(message: string): void {
  try {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "lifecycle.log");

    try {
      if (statSync(file).size > MAX_BYTES) writeFileSync(file, "");
    } catch {
      // 文件还不存在：append 会创建
    }

    appendFileSync(file, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // 日志失败不能反过来影响退出
  }
}
