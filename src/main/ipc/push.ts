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

/**
 * 需要批量聚合的推送通道 → 聚合窗口（毫秒）。
 * 未在表里的通道立即发送。
 */
const BATCH_WINDOWS: Partial<Record<IpcPushChannel, number>> = {
  // 16ms 内的流式事件合并为一批发送，避免高频 IPC 抖动
  "agent:event": 16,
};

interface PendingBatch {
  items: unknown[];
  timer: NodeJS.Timeout | null;
}

let mainWindow: BrowserWindow | null = null;

/** 各通道的待发送队列。先清空再发送，避免窗口缺失时残留导致内存泄漏 */
const pending = new Map<IpcPushChannel, PendingBatch>();

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
function flushChannel(channel: IpcPushChannel): void {
  const entry = pending.get(channel);
  if (!entry) return;

  const items = entry.items;
  entry.items = [];
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  for (const item of items) send(channel, item);
}

/**
 * 类型安全的推送。
 * 在 BATCH_WINDOWS 里声明过的通道自动参与批量聚合，其余通道立即发送。
 */
export function push<C extends IpcPushChannel>(channel: C, payload: IpcPushMap[C]): void {
  const windowMs = BATCH_WINDOWS[channel];
  if (windowMs === undefined) {
    send(channel, payload);
    return;
  }

  let entry = pending.get(channel);
  if (!entry) {
    entry = { items: [], timer: null };
    pending.set(channel, entry);
  }
  entry.items.push(payload);
  if (!entry.timer) {
    entry.timer = setTimeout(() => flushChannel(channel), windowMs);
  }
}

/** 立即冲掉所有待发送的事件（运行结束 / 中断时调用，保证到达顺序） */
export function flushEvents(): void {
  for (const [channel, entry] of pending) {
    if (entry.items.length > 0) flushChannel(channel);
  }
}
