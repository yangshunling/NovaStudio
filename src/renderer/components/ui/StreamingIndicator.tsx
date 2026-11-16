/**
 * 流式指示器 — 运行中的状态灯
 *
 * 只说明「正在运行」这一件事：静态圆点 + 文案。
 * 不用流光文字，避免状态提示比正文还抢眼。
 */

export function StreamingIndicator() {
  return (
    <div
      className="flex items-center gap-2 px-1 ui-type-item text-text-muted"
      role="status"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
      <span>正在运行</span>
    </div>
  );
}
