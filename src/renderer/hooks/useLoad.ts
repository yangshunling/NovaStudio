/**
 * useLoad — 列表/资产加载的统一 Hook
 *
 * 收敛渲染层反复手写的「挂载时拉取 → loading → error → data」四态逻辑：
 *
 *   const { data, loading, error, reload } = useLoad(() => ipc.listMcpServers(), []);
 *
 * 保证点：
 * - 卸载后异步回调不再 setState（cancelled 标志，避免 React 内存泄漏警告）
 * - reload 主动重拉（刷新按钮、操作完成后刷新）
 * - deps 变化自动重载；依赖稳定则不重复跑
 *
 * 不适合：需并行多源拉取、或结果要进全局 store 的场景——
 * 那些仍建议自己写 effect，或在 store 里封装。
 */

import { useCallback, useEffect, useState } from "react";
import { toMessage } from "../lib/utils";

export interface LoadState<T> {
  data: T;
  loading: boolean;
  error: string | null;
  /** 重新拉取 */
  reload: () => void;
  /** 就地更新 data（乐观更新 / 推送事件落地用），无需重拉 */
  setData: (next: T | ((prev: T) => T)) => void;
}

export function useLoad<T>(
  loader: () => Promise<T>,
  initial: T,
  deps: ReadonlyArray<unknown> = [],
): LoadState<T> {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // reload 不重建 loader 引用，而是 bump tick 让 effect 重跑
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    /*
     * 用 Promise.resolve() 包一层：loader 若同步抛错（例如依赖未就绪时
     * 直接 throw），裸调会让异常在 effect 里逃逸到 ErrorBoundary，整页被
     * 兜底；包一层后同步异常也变成 rejection，走下面的 catch 只影响本区块。
     */
    Promise.resolve()
      .then(() => loader())
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(toMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  // loader/deps 由调用方保证稳定；显式忽略让 deps 成为唯一重载来源
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const update = useCallback(
    (next: T | ((prev: T) => T)) =>
      setData((prev) => (typeof next === "function" ? (next as (p: T) => T)(prev) : next)),
    [],
  );

  return { data, loading, error, reload, setData: update };
}