/**
 * 资产页共用小件
 *
 * Skill / MCP 两个资产页的标签、元信息与时间格式都收敛在这里，
 * 避免配色和字号在页面之间漂移。
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export const TAG_TONE_CLASS = {
  neutral: "text-text-muted",
  error: "text-error",
  warning: "text-agent-amber",
  success: "text-success",
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
      className={`inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 ui-type-note ${TAG_TONE_CLASS[tone]}`}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {children}
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
      <div className="ui-type-note text-text-muted">{label}</div>
      <div
        className={`mt-0.5 ui-type-body text-text-secondary ${
          mono ? "truncate ui-type-code" : "break-words"
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
