/**
 * 工作区页共用的小型 UI 原语
 *
 * 只服务「工作区」页，样式定义在 workspace.css 的 ws-* 命名空间内。
 * 不放进 components/ui：这些元素属于工作台的设计语言，不是全站通用件。
 */

import type { ReactNode } from "react";

/** 工作台空态：图标方块 + 标题 + 说明 + 可选操作 */
export function WorkspaceEmptyState({
  icon,
  title,
  description,
  children,
  className = "",
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ws-empty ${className}`.trim()}>
      <span className="ws-empty-icon">{icon}</span>
      <p className="ws-empty-title">{title}</p>
      {description && <p className="ws-empty-desc">{description}</p>}
      {children}
    </div>
  );
}
