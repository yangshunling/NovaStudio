/**
 * 侧栏列表窗格
 *
 * 会话 / 工作区 / 知识库 / 终端四个左栏使用同一套尺寸与行样式：
 * - 宽度统一取 --c-layout-session-list（268px）
 * - 头部：小号章节标签 + 计数徽标 + 圆形图标按钮
 * - 行：36px 图标容器 + 两行文字 + 右侧附加信息
 *
 * 业务只提供内容；选中态、悬浮态、右键菜单与键盘行为由这里统一。
 */

import type { ReactNode, MouseEvent } from "react";

interface ListPaneProps {
  title: string;
  count?: number;
  /** 头部右侧操作（通常是圆形图标按钮） */
  action?: ReactNode;
  /** 底部说明区 */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ListPane({
  title,
  count,
  action,
  footer,
  children,
  className = "",
}: ListPaneProps) {
  return (
    <aside
      className={`flex w-[var(--c-layout-session-list)] shrink-0 flex-col border-r border-border bg-[var(--c-panel-bg)] shadow-[var(--c-shadow-sm)] ${className}`.trim()}
    >
      <div className="flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-meta font-semibold tracking-wide text-text-muted">
            {title}
          </p>
          {count !== undefined && (
            <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-surface-hover px-1.5 font-mono text-caption leading-none text-text-muted">
              {count}
            </span>
          )}
        </div>
        {action}
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-4 pt-4">
        {children}
      </div>

      {footer && (
        <div className="shrink-0 border-t border-border p-2.5">{footer}</div>
      )}
    </aside>
  );
}

interface ListItemProps {
  /** 图标容器内容；与 leading 二选一 */
  icon?: ReactNode;
  /** 无图标时的行首节点（如状态点 / 转圈） */
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 副标题使用等宽字体（路径 / 目录） */
  monoSubtitle?: boolean;
  trailing?: ReactNode;
  active?: boolean;
  onClick?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  titleAttr?: string;
}

export function ListItem({
  icon,
  leading,
  title,
  subtitle,
  monoSubtitle = false,
  trailing,
  active = false,
  onClick,
  onContextMenu,
  titleAttr,
}: ListItemProps) {
  return (
    <div
      className={`ui-cv-row relative flex w-full items-center rounded-lg transition-colors ${
        active
          ? "bg-accent-soft/60 text-text"
          : "text-text-secondary hover:bg-surface-hover/70 hover:text-text"
      }`}
    >
      {/* 选中态：左侧细竖条，与会话列表保持一致 */}
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-accent"
        />
      )}

      <button
        type="button"
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={titleAttr}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
      >
        {icon ? (
          <span
            className={`grid h-6 w-6 shrink-0 place-items-center ${
              active ? "text-accent" : "text-text-muted"
            }`}
          >
            {icon}
          </span>
        ) : (
          leading
        )}

        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-body-lg leading-5 ${
              active ? "font-medium" : ""
            }`}
          >
            {title}
          </span>
          {subtitle !== undefined && subtitle !== null && (
            <span
              className={`block truncate text-caption text-text-muted ${
                monoSubtitle ? "font-mono" : ""
              }`}
            >
              {subtitle}
            </span>
          )}
        </span>

        {trailing}
      </button>
    </div>
  );
}
