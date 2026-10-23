/**
 * 资产页共用小件
 *
 * Skill / MCP 两个资产页的标签、元信息、来源徽标与时间格式都收敛在这里，
 * 避免配色和字号在页面之间漂移。
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export const TAG_TONE_CLASS = {
  neutral: "bg-surface-hover text-text-muted",
  error: "bg-error-bg text-error",
  warning: "bg-agent-amber/10 text-agent-amber",
  success: "bg-success/10 text-success",
} as const;

export function Tag({
  icon: Icon,
  children,
  tone = "neutral",
  title,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  tone?: keyof typeof TAG_TONE_CLASS;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-meta ${TAG_TONE_CLASS[tone]}`}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  );
}

export function SourceTag({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-caption font-medium ${className}`}
    >
      {label}
    </span>
  );
}

export function Meta({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-meta text-text-muted">{label}</div>
      <div
        className={`mt-0.5 text-body text-text-secondary ${
          mono ? "truncate font-mono text-meta" : "break-words"
        }`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

/** 资产页统一的时间格式：月-日 时:分 */
export function formatAssetTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
