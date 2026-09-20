/**
 * 流式指示器 — "Nova 正在忙碌…" 流光动画
 */

export function StreamingIndicator() {
  return (
    <div className="flex items-center gap-2 px-1 text-body-lg text-text-muted">
      <span className="shimmer">Nova 正在忙碌…</span>
    </div>
  );
}