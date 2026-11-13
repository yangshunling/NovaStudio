/**
 * 工作区文件变动的渲染层订阅
 *
 * 同一时刻可能有多个视图在看同一个工作区（会话右侧文件树、工作区文件页），
 * 各自的展开状态不同。这里按「来源」登记目录集合，取并集后统一发给主进程，
 * 避免后挂载的视图把前一个的监听集合覆盖掉。
 *
 * 主进程按项目推送 workspace:changed，本模块只负责分发给对应项目的订阅者；
 * 具体重拉哪些目录由订阅者自己判断（它才知道哪些目录已加载）。
 */

import { ipc } from "./ipc";

type DirListener = (dirs: string[]) => void;

/** projectId → 来源标识 → 需要监听的相对目录 */
const sources = new Map<string, Map<string, Set<string>>>();
/** projectId → 订阅者 */
const listeners = new Map<string, Set<DirListener>>();
/** 最近一次发给主进程的目录集合，避免重复 IPC */
const sent = new Map<string, string[]>();
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.onWorkspaceChanged(({ projectId, dirs }) => {
    const targets = listeners.get(projectId);
    if (!targets) return;
    for (const listener of targets) listener(dirs);
  });
}

/** 当前项目的目录并集发给主进程 */
function sync(projectId: string): void {
  const union = new Set<string>();
  for (const dirs of sources.get(projectId)?.values() ?? []) {
    for (const dir of dirs) union.add(dir);
  }
  const next = [...union].sort();
  const previous = sent.get(projectId) ?? [];
  if (
    next.length === previous.length &&
    next.every((dir, index) => dir === previous[index])
  ) {
    return;
  }
  sent.set(projectId, next);
  void ipc.watchWorkspace(projectId, next).catch(() => {
    // 主进程未就绪 / 项目已删除：下一条事件会重新同步，不打扰用户
  });
}

/** 登记某个视图要监听的目录（空数组表示该视图不看任何目录） */
export function setWatchSource(
  projectId: string,
  source: string,
  dirs: string[],
): void {
  ensureSubscribed();
  let bySource = sources.get(projectId);
  if (!bySource) {
    bySource = new Map();
    sources.set(projectId, bySource);
  }
  bySource.set(source, new Set(dirs));
  sync(projectId);
}

/** 视图卸载时撤销自己的监听来源 */
export function clearWatchSource(projectId: string, source: string): void {
  const bySource = sources.get(projectId);
  if (!bySource) return;
  bySource.delete(source);
  if (bySource.size > 0) {
    sync(projectId);
    return;
  }

  sources.delete(projectId);
  sent.set(projectId, []);
  void ipc.watchWorkspace(projectId, []).catch(() => {});
}

/** 订阅某个项目的文件变更；返回取消订阅函数 */
export function subscribeWorkspaceChanges(
  projectId: string,
  listener: DirListener,
): () => void {
  ensureSubscribed();
  let set = listeners.get(projectId);
  if (!set) {
    set = new Set();
    listeners.set(projectId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(projectId);
  };
}
