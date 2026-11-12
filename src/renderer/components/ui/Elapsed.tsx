/**
 * 耗时文本 —— 自计时叶子组件
 *
 * 运行中的耗时每秒都在变。若把 `now` 放在页面组件里，整页（节点列表、
 * 对话、产物）会跟着每秒 diff 一次；这里把时钟收进叶子节点，父级不再订阅。
 *
 *   <Elapsed startedAt={run.startedAt} finishedAt={run.finishedAt} />
 *
 * 只有「已开始且未结束」时才起定时器；结束后渲染静态文本，不再 tick。
 */

import { useEffect, useState } from "react";
import { formatDuration } from "@shared/time";

export function Elapsed({
  startedAt,
  finishedAt,
  className,
}: {
  startedAt: number | null;
  finishedAt: number | null;
  className?: string;
}) {
  const ticking = startedAt !== null && finishedAt === null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) return;
    // 首帧可能晚于挂载（父级刚拿到 startedAt），先对齐一次
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  return (
    <span className={className}>
      {formatDuration(startedAt, finishedAt, now)}
    </span>
  );
}
