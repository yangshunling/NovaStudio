/**
 * 流式值节流
 *
 * 流式正文每个 token 都在变化。如果每次变化都让 Markdown 解析器 / 代码高亮
 * 重新跑一遍，主线程会被完全占满，表现为文字“一卡一卡地往外蹦”。
 *
 * 这里把可见文本的更新频率压到 intervalMs 一次：首个值立即生效（打字机感），
 * 期间只保留最新值，最后一次变化一定会被提交（不会丢结尾）。
 */

import { useEffect, useRef, useState } from "react";

/**
 * Markdown 的刷新间隔。
 *
 * 解析成本随文本长度线性增长（实测 4KB≈8ms、12KB≈18ms、32KB≈48ms），
 * 固定间隔在长回复上会把主线程占满。这里按长度放大间隔：
 * 短文本保持打字机手感，长文本降低刷新频率。
 *
 * @param length 当前已显示文本的长度
 * @param base   短文本时的间隔（正文 80ms，思考块可稍大）
 */
export function markdownInterval(length: number, base = 80): number {
  if (length > 16_000) return Math.max(base, 200);
  if (length > 8_000) return Math.max(base, 150);
  return base;
}

export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [rendered, setRendered] = useState(value);
  const latestRef = useRef(value);
  const lastCommitRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latestRef.current = value;
    if (timerRef.current) return; // 已排定：到点后会用最新值提交
    if (value === rendered) return;

    const wait = Math.max(0, intervalMs - (Date.now() - lastCommitRef.current));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastCommitRef.current = Date.now();
      setRendered(latestRef.current);
    }, wait);
  }, [value, rendered, intervalMs]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return rendered;
}
