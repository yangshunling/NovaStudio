/**
 * 流式事件的批量聚合
 *
 * 抽成独立模块的原因：聚合时序（窗口内合并、flush 保证顺序）是容易被改坏的
 * 逻辑，而 push.ts 依赖 Electron 的窗口对象，无法在 node --test 里直接验证。
 * 这里不依赖任何 Electron API。
 */

export interface BatchQueue<T> {
  /** 入队。窗口内的后续调用会并入同一批 */
  push(item: T): void;
  /** 立即发送当前队列（未入队时为空操作）；发送期间新入队的内容留到下一批 */
  flush(): void;
  /** 尚未发送的条数，供调用方判断是否需要 flush */
  readonly size: number;
}

export function createBatchQueue<T>(
  windowMs: number,
  send: (item: T) => void,
): BatchQueue<T> {
  let items: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (items.length === 0) return;
    // 先摘出队列再发送：send 抛错或重入都不会让同一批被发两次
    const batch = items;
    items = [];
    for (const item of batch) send(item);
  };

  return {
    push(item: T): void {
      items.push(item);
      if (!timer) timer = setTimeout(flush, windowMs);
    },
    flush,
    get size(): number {
      return items.length;
    },
  };
}
