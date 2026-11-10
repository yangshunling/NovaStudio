/**
 * 流式指示器 — "Nova is working..." 流光动画
 */

export function StreamingIndicator() {
  return (
    <div className="flex items-center gap-2 px-1 ui-type-item text-text-muted">
      <span className="shimmer">Nova is working...</span>
    </div>
  );
}