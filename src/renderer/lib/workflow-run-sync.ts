/**
 * 工作流运行状态的统一刷新入口
 *
 * 三个界面（侧栏、工作流页、运行记录页）此前各自 `ipc.on.workflowRunEvent`
 * + 各自 10 秒兜底轮询，导致：
 *   - 同一事件触发三次重复查库；
 *   - 三处防抖窗口/轮询条件不一致，状态短时间不同步；
 *   - 页面越多，定时器越多。
 *
 * 现在由这个模块独占「订阅 + 防抖 + 兜底轮询」，各界面只登记自己的 loader：
 *   const off = registerWorkflowRunLoader(load, () => hasActive);
 * loader 的第二个返回值告诉这里「当前是否有活跃运行」，只有存在活跃运行时
 * 才开启 10 秒兜底，空闲时完全停掉。
 */

import { ipc } from "./ipc";

type Loader = {
  run: () => void | Promise<void>;
  /** 当前是否有需要兜底的活跃运行（轮询只为兜住漏掉的终态） */
  isActive: () => boolean;
};

const loaders = new Set<Loader>();
let subscribed = false;
let debounce: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** 推送是主链路：事件到达后合并 200ms 再统一刷新 */
const EVENT_DEBOUNCE_MS = 200;
/** 兜底周期：只用于兜住漏掉的终态 */
const FALLBACK_INTERVAL_MS = 10_000;

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on.workflowRunEvent(() => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void refreshAll(), EVENT_DEBOUNCE_MS);
  });
}

async function refreshAll(): Promise<void> {
  for (const loader of [...loaders]) {
    try {
      await loader.run();
    } catch {
      // 各 loader 自己负责把失败呈现给用户；这里只保证其它界面继续刷新
    }
  }
  // loader 更新的是组件状态，等一帧再判断 isActive()，否则读到的是刷新前的快照
  setTimeout(syncFallbackTimer, 0);
}

/** 有活跃运行才轮询；全部结束立即停掉，避免空闲耗电 */
function syncFallbackTimer(): void {
  const needed = [...loaders].some((loader) => loader.isActive());
  if (needed && !timer) {
    timer = setInterval(() => void refreshAll(), FALLBACK_INTERVAL_MS);
    return;
  }
  if (!needed && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 立即刷新所有已登记的列表。
 *
 * 首屏与手动刷新都走这里：统一在刷新后重新判断是否需要兜底轮询。
 */
export function refreshWorkflowRuns(): Promise<void> {
  return refreshAll();
}

/**
 * 登记一个运行列表刷新器，返回取消登记函数。
 *
 * 调用方登记后仍需触发一次首屏刷新（见 refreshWorkflowRuns）。
 */
export function registerWorkflowRunLoader(loader: Loader): () => void {
  ensureSubscribed();
  loaders.add(loader);
  syncFallbackTimer();
  return () => {
    loaders.delete(loader);
    syncFallbackTimer();
  };
}
