/**
 * Nova — Preload 脚本，安全桥接
 *
 * 通过 contextBridge 暴露受限的 IPC 通道。渲染进程只能调用这里暴露的能力，
 * 无法直接访问 Node.js API。
 *
 * 通道名与参数 / 返回值类型来自 shared/contracts/ipc.ts，
 * 与主进程 handler 共用同一份契约 —— 任何一方改了形状，另一方立即编译报错。
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";
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

/** 读取主进程通过 webPreferences.additionalArguments 注入的参数 */
function readArgument(name: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

const api = {
  invoke,
  subscribe,
  /**
   * Office 查看器的回环静态服务基址。
   * 生产环境由主进程在 127.0.0.1 的随机端口上提供，查看器 iframe 从这里加载；
   * 开发模式为空串，渲染层改用 dev server 同源地址。
   */
  viewerBaseUrl: readArgument("nova-viewer-base"),
  /**
   * 取拖入文件的真实路径（Electron 32 起 File.path 已移除）。
   * 渲染层只能通过这里拿路径，不能直接访问 Node API。
   */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
};

export type NovaBridge = typeof api;

contextBridge.exposeInMainWorld("nova", api);
