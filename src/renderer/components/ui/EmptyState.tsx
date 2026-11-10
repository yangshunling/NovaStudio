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
import { Search } from "lucide-react";
import { Spinner } from "./Spinner";

type EmptyStateSize = "default" | "compact";

interface EmptyStateProps {
  /** 图标节点；传 LucideIcon 元素即可，内部统一尺寸与容器 */
  icon?: ReactNode;
  title: string;
  /** 补充说明，可含换行 */
  description?: ReactNode;
  /** 主操作按钮 */
  action?: ReactNode;
  /** 说明与操作之间的自定义内容（如三步引导） */
  children?: ReactNode;
  size?: EmptyStateSize;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  children,
  size = "default",
  className = "",
}: EmptyStateProps) {
  const compact = size === "compact";

  // 紧凑态：卡片内 / 侧栏里的局部空态，保持安静
  if (compact) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center ${className}`.trim()}
      >
        {icon && (
          <div className="text-text-muted opacity-50 [&>svg]:h-6 [&>svg]:w-6">
            {icon}
          </div>
        )}
        <h2 className="ui-type-body text-text-secondary">{title}</h2>
        {description && (
          <p className="ui-type-note max-w-md leading-relaxed text-text-muted">
            {description}
          </p>
        )}
        {action && <div className="mt-1">{action}</div>}
      </div>
    );
  }

  /*
   * 整页空态：编辑式排版。
   * 用静态细线 + 留白建立起点，不再使用渐变/光晕——与侧栏刊头保持同一气质。
   */
  return (
    <div
      className={`flex min-h-[60vh] items-center justify-center ${className}`.trim()}
    >
      <div className="relative w-full max-w-[640px] overflow-hidden rounded-2xl border border-border/60 bg-surface-2/40 p-8 text-center shadow-[var(--c-shadow-sm)]">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-10 top-0 h-px bg-accent/30"
        />

        <div className="relative flex flex-col items-center">
          {icon && (
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-accent text-accent-foreground shadow-[var(--c-shadow-sm)] [&>svg]:h-6 [&>svg]:w-6">
              {icon}
            </div>
          )}

          <h2 className="ui-type-heading mt-5 tracking-tight text-text">
            {title}
          </h2>

          {description && (
            <p className="ui-type-body mt-2 max-w-md leading-relaxed text-text-secondary">
              {description}
            </p>
          )}

          {children}

          {action && <div className="mt-6">{action}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * 筛选无结果空态：列表页搜索框下方的统一提示。
 *
 * 传 onClear 时显示「清除搜索」；没有查询词（例如来源筛选为空）时不传。
 */
export function FilterEmpty({
  title,
  onClear,
  icon,
  clearLabel = "清除搜索",
}: {
  title: string;
  onClear?: () => void;
  icon?: ReactNode;
  /** 操作按钮文案；按状态筛选时可用「查看全部」这类更贴切的措辞 */
  clearLabel?: string;
}) {
  return (
    <EmptyState
      size="compact"
      icon={icon ?? <Search />}
      title={title}
      action={
        onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="ui-type-note text-accent hover:underline"
          >
            {clearLabel}
          </button>
        ) : undefined
      }
    />
  );
}

/**
 * 虚线框空态：对话框 / 面板 / 拖拽区里"还没有内容"的统一形态。
 *
 * 与 EmptyState compact 的区别只是多一个虚线容器，内容排版完全一致。
 */
export function EmptyBlock({
  icon,
  title,
  description,
  action,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`rounded-xl border border-dashed border-border-strong bg-surface-2/40 ${className}`.trim()}
    >
      <EmptyState
        size="compact"
        icon={icon}
        title={title}
        description={description}
        action={action}
      />
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
        compact ? "h-40 ui-type-note" : "h-60 ui-type-body"
      } ${className}`.trim()}
    >
      <Spinner className="h-4 w-4" />
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
      <p className={`${compact ? "ui-type-note" : "ui-type-body"} text-error`}>
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