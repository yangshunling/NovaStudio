/**
 * 空态提示
 *
 * 统一列表/内容为空时的展示。三种形态覆盖全部场景：
 *
 *   <EmptyState icon={<Users />} title="..." description="..." action={<Button />} />
 *   <EmptyState size="compact" icon={<Search />} title="没有匹配的结果" />
 *   <EmptyState title="正在加载" />           // 无图标的最简形态
 *
 * size:
 * - "default"：整页空态，大图标 + 标题 + 说明 + 操作（列表为空）
 * - "compact"：局部空态，小号、紧凑（卡片内 / 侧栏 / 筛选无结果）
 */

import type { ReactNode } from "react";

type EmptyStateSize = "default" | "compact";

interface EmptyStateProps {
  /** 图标节点；传 LucideIcon 元素即可，内部统一尺寸与容器 */
  icon?: ReactNode;
  title: string;
  /** 补充说明，可含换行 */
  description?: ReactNode;
  /** 主操作按钮 */
  action?: ReactNode;
  size?: EmptyStateSize;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  size = "default",
  className = "",
}: EmptyStateProps) {
  const compact = size === "compact";

  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? "gap-1.5 px-6 py-10" : "gap-3 py-20"
      } ${className}`.trim()}
    >
      {icon && (
        <div
          className={
            compact
              ? "text-text-muted opacity-50 [&>svg]:h-6 [&>svg]:w-6"
              : "ui-btn-round flex h-16 w-16 items-center justify-center rounded-2xl text-text-muted [&>svg]:h-6 [&>svg]:w-6"
          }
        >
          {icon}
        </div>
      )}

      <h2
        className={
          compact
            ? "text-body text-text-secondary"
            : "ui-serif text-heading font-semibold text-text-secondary"
        }
      >
        {title}
      </h2>

      {description && (
        <p
          className={`max-w-md leading-relaxed text-text-muted ${
            compact ? "text-meta" : "text-body"
          }`}
        >
          {description}
        </p>
      )}

      {action && <div className={compact ? "mt-1" : "mt-2"}>{action}</div>}
    </div>
  );
}

/**
 * 加载态：转圈 + 文案。
 *
 * 与 EmptyState 同尺寸，让 loading → empty 切换时不跳动。
 */
export function LoadingState({
  text = "正在加载",
  size = "default",
  className = "",
}: {
  text?: string;
  size?: EmptyStateSize;
  className?: string;
}) {
  const compact = size === "compact";
  return (
    <div
      className={`flex items-center justify-center gap-2 text-text-muted ${
        compact ? "h-40 text-meta" : "h-60 text-body"
      } ${className}`.trim()}
    >
      <svg
        className="h-4 w-4 animate-spin"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          strokeWidth="3"
          className="opacity-25"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      {text}
    </div>
  );
}

/**
 * 错误态：错误信息 + 重试按钮。
 *
 * 页面级加载失败统一用它，避免每个页面自己拼「红字 + 重新加载」。
 */
export function ErrorState({
  message,
  onRetry,
  size = "default",
  className = "",
}: {
  message: string;
  onRetry?: () => void;
  size?: EmptyStateSize;
  className?: string;
}) {
  const compact = size === "compact";
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 text-center ${
        compact ? "py-10" : "py-20"
      } ${className}`.trim()}
    >
      <p className={`${compact ? "text-meta" : "text-body"} text-error`}>
        {message}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ui-btn ui-btn-ghost ui-btn-sm"
        >
          重新加载
        </button>
      )}
    </div>
  );
}