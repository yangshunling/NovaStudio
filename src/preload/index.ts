/**
 * Nova — Preload 脚本，安全桥接
 *
 * 通过 contextBridge 暴露受限的 IPC 通道。渲染进程只能调用这里暴露的能力，
 * 无法直接访问 Node.js API。
 *
 * 通道名与参数 / 返回值类型来自 shared/contracts/ipc.ts，
 * 与主进程 handler 共用同一份契约 —— 任何一方改了形状，另一方立即编译报错。
 */

import { contextBridge, ipcRenderer } from "electron";
import type {
  IpcArgs,
  IpcInvokeChannel,
  IpcPushChannel,
  IpcPushMap,
  IpcResult,
} from "../shared/contracts/ipc";

/** 调用主进程并返回契约声明的结果类型 */
function invoke<C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> {
  return ipcRenderer.invoke(channel, ...(args as unknown[])) as Promise<IpcResult<C>>;
}

/** 订阅主进程推送，返回取消订阅函数 */
function subscribe<C extends IpcPushChannel>(
  channel: C,
  callback: (payload: IpcPushMap[C]) => void,
): () => void {
  const handler = (_event: unknown, payload: unknown) => {
    callback(payload as IpcPushMap[C]);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = { invoke, subscribe };

export type NovaBridge = typeof api;

contextBridge.exposeInMainWorld("nova", api);
