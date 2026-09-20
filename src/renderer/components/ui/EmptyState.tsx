/**
 * 空态提示
 *
 * 统一空列表/空内容的图标 + 标题 + 可选操作按钮展示。
 */

import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, action, className = "" }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${className}`}>
      {icon && <div className="mb-2 text-text-muted opacity-40">{icon}</div>}
      <p className="text-meta text-text-muted">{title}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}