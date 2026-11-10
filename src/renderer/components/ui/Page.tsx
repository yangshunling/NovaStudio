/**
 * 页面骨架 — 所有侧栏页面的统一外壳
 *
 * 收敛 8 个 View 里逐字重复的 main + ui-page 三层壳：
 *
 *   <Page>
 *     <PageHeader title="MCP" count={n} countSuffix="个服务" actions={...} />
 *     <PageToolbar>...筛选条...</PageToolbar>
 *     <PageBody>...主体...</PageBody>
 *   </Page>
 *
 * - 全站使用同一套字号量表，页面不再局部覆盖 --c-font-size
 * - PageHeader 标题栏统一 h-[--c-layout-header]、glass、底分隔线
 * - 标题右侧统一放搜索/刷新/新建；count 作为紧凑徽标
 */

import type { ReactNode } from "react";

interface PageProps {
  children: ReactNode;
  className?: string;
}

export function Page({ children, className = "" }: PageProps) {
  return (
    <main
      className={`relative flex flex-1 flex-col overflow-hidden ${className}`.trim()}
    >
      <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden rounded-xl">
        {children}
      </div>
    </main>
  );
}

interface PageHeaderProps {
  /** 标题文字 */
  title: ReactNode;
  /** 标题旁的计数徽标（如 3），与 countSuffix 组合显示 */
  count?: number;
  /** 计数徽标的后缀（如 "个服务"），仅 count 有值时显示 */
  countSuffix?: string;
  /** 自定义徽标节点，优先于 count（用于「本机配置」这类固定文案） */
  badge?: ReactNode;
  /** 标题左侧图标（页面级 / 双栏右侧面板） */
  icon?: ReactNode;
  /** 标题下方副标题（工作区路径等），统一等宽小字 */
  subtitle?: ReactNode;
  /** 标题栏右侧操作区（搜索/刷新/新建） */
  actions?: ReactNode;
  /** 标题栏额外类名 */
  className?: string;
}

export function PageHeader({
  title,
  count,
  countSuffix,
  badge,
  icon,
  subtitle,
  actions,
  className = "",
}: PageHeaderProps) {
  return (
    <header
      className={`ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-3 border-b border-border px-card ${className}`.trim()}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <span className="shrink-0 text-accent">{icon}</span>}
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="ui-type-title truncate text-text-secondary">
              {title}
            </span>
            {badge ??
              (count !== undefined && (
                <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-surface-hover px-1.5 ui-type-code-sm leading-none text-text-muted">
                  {count}
                  {countSuffix}
                </span>
              ))}
          </div>
          {subtitle && (
            <div
              className="ui-type-code-sm truncate text-text-muted"
              title={typeof subtitle === "string" ? subtitle : undefined}
            >
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex min-w-0 items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

/** 顶栏下方的次级工具条（筛选 chips / 说明），统一底分隔线 */
export function PageToolbar({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-card py-2 ${className}`.trim()}
    >
      {children}
    </div>
  );
}

/** 可滚动的页面主体
 *
 * scroll={false} 用于「表单要占满可视高度」的页面（如提示词编辑器）：
 * 取消滚动，改为 flex 纵向布局，让子元素用 flex-1 撑满剩余高度。
 */
export function PageBody({
  children,
  className = "",
  scroll = true,
}: {
  children: ReactNode;
  className?: string;
  scroll?: boolean;
}) {
  return (
    <div
      className={`min-h-0 flex-1 p-section ${
        scroll ? "overflow-y-auto" : "flex flex-col overflow-hidden"
      } ${className}`.trim()}
    >
      {children}
    </div>
  );
}