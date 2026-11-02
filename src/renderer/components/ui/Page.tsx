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
 * - 资产页需要放大字号时传 fontSize（注入 --c-font-size）
 * - PageHeader 标题栏统一 h-[--c-layout-header]、glass、底分隔线
 * - 标题右侧统一放搜索/刷新/新建；count 作为紧凑徽标
 */

import type { CSSProperties, ReactNode } from "react";

interface PageProps {
  children: ReactNode;
  /** 资产页放大字号（注入 --c-font-size）；不传则不注入 */
  fontSize?: number;
  className?: string;
}

export function Page({ children, fontSize, className = "" }: PageProps) {
  const style = (
    fontSize ? { "--c-font-size": `${fontSize}px` } as CSSProperties : undefined
  );
  return (
    <main
      className={`relative flex flex-1 flex-col overflow-hidden ${className}`.trim()}
      style={style}
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
  actions,
  className = "",
}: PageHeaderProps) {
  return (
    <header
      className={`ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-3 border-b border-border px-card ${className}`.trim()}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="ui-serif text-title font-semibold tracking-wide text-text-secondary">
          {title}
        </span>
        {badge ?? (count !== undefined && (
          <span className="rounded-full bg-surface-hover px-2 py-0.5 text-meta font-mono text-text-muted">
            {count}
            {countSuffix}
          </span>
        ))}
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

/** 可滚动的页面主体 */
export function PageBody({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`min-h-0 flex-1 overflow-y-auto p-section ${className}`.trim()}
    >
      {children}
    </div>
  );
}