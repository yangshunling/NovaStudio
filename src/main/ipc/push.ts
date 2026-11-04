/**
 * 主进程 → 渲染进程的推送通道
 *
 * 统一持有窗口引用，负责窗口存活检查与流式事件的批量聚合。
 * 窗口未就绪时静默丢弃（而非抛错）—— 与既有行为一致。
 *
 * 哪些通道需要聚合由 BATCH_WINDOWS 声明：新增高频通道只需在表里加一行，
 * 不必改动 push 的实现。
 */

import { BrowserWindow } from "electron";
import type { IpcPushChannel, IpcPushMap } from "../../shared/contracts/ipc";
import { createBatchQueue, type BatchQueue } from "./batch";

/**
 * 需要批量聚合的推送通道 → 聚合窗口（毫秒）。
 * 未在表里的通道立即发送。
 */
const BATCH_WINDOWS: Partial<Record<IpcPushChannel, number>> = {
  // 16ms 内的流式事件合并为一批发送，避免高频 IPC 抖动
  "agent:event": 16,
  "workflow:run:agentEvent": 16,
};

let mainWindow: BrowserWindow | null = null;

/** 各通道的待发送队列。窗口缺失时由 flush 直接丢弃，不会残留内存 */
const queues = new Map<IpcPushChannel, BatchQueue<unknown>>();

/**
 * 更新窗口引用。必须在窗口创建后调用，
 * 否则所有推送会因窗口为 null 而静默丢弃，渲染进程将永远等待。
 */
export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

/** 供需要父窗口的原生对话框使用 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function send(channel: string, payload: unknown): void {
  const window = getMainWindow();
  if (window) window.webContents.send(channel, payload);
}

/** 冲掉某个通道的待发送事件 */
function queueOf(channel: IpcPushChannel): BatchQueue<unknown> {
  const windowMs = BATCH_WINDOWS[channel]!;
  let queue = queues.get(channel);
  if (!queue) {
    queue = createBatchQueue<unknown>(windowMs, (item) => send(channel, item));
    queues.set(channel, queue);
  }
  return queue;
}

/**
 * 类型安全的推送。
 * 在 BATCH_WINDOWS 里声明过的通道自动参与批量聚合，其余通道立即发送。
 */
export function push<C extends IpcPushChannel>(channel: C, payload: IpcPushMap[C]): void {
  if (BATCH_WINDOWS[channel] === undefined) {
    send(channel, payload);
    return;
  }
  queueOf(channel).push(payload);
}

/** 立即冲掉所有待发送的事件（运行结束 / 中断时调用，保证到达顺序） */
export function flushEvents(): void {
  for (const queue of queues.values()) {
    if (queue.size > 0) queue.flush();
  }
}
