/**
 * 加载圆环
 *
 * Material 风格的无限循环进度环：底环保持低透明度，
 * 前景弧线一边旋转一边伸缩，比匀速旋转的静态圆圈更像「正在处理」。
 *
 *   <Spinner className="h-3.5 w-3.5 text-accent" />
 *
 * 颜色跟随 currentColor，尺寸由外部 className 控制。
 */

export function Spinner({
  className = "",
  label = "正在加载",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="status"
      aria-label={label}
      className={`ui-spinner ${className}`.trim()}
      fill="none"
      stroke="currentColor"
    >
      <circle
        className="ui-spinner-arc"
        cx="12"
        cy="12"
        r="9"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
