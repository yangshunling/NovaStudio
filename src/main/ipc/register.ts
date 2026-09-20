/**
 * 类型安全的 IPC handler 注册
 *
 * 通道名、参数、返回值全部来自 shared/contracts/ipc.ts。
 * preload 与主进程只要有一方改了通道形状，另一方立即编译报错，
 * 从根本上消除「通道名各写一遍字符串」的漂移问题。
 */

import { ipcMain } from "electron";
import type { IpcArgs, IpcInvokeChannel, IpcResult } from "../../shared/contracts/ipc";

type Handler<C extends IpcInvokeChannel> = (
  ...args: IpcArgs<C>
) => Promise<IpcResult<C>> | IpcResult<C>;

/** 注册一个 invoke 通道处理器 */
export function handle<C extends IpcInvokeChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, (_event, ...args: unknown[]) =>
    (handler as (...a: unknown[]) => unknown)(...args),
  );
}
