/**
 * 标记药丸（Badge/Pill）
 *
 * 统一 Agent/项目/状态的紧凑标记样式。
 * variant: "accent"（渐变强调色）/ "neutral"（中性灰）
 */

import type { ReactNode } from "react";

interface PillProps {
  icon?: ReactNode;
  children: ReactNode;
  variant?: "accent" | "neutral" | "success" | "error" | "warning";
  maxWidth?: string;
  className?: string;
  /** 覆盖 variant 的配色（Agent 标识色等动态 tone） */
  toneClassName?: string;
  title?: string;
}

const variantClasses: Record<NonNullable<PillProps["variant"]>, string> = {
  accent: "bg-accent-soft text-accent",
  neutral: "bg-surface-hover text-text-muted",
  success: "bg-accent-soft text-success",
  error: "bg-error-bg text-error",
  warning: "bg-agent-amber/10 text-agent-amber",
};

export function Pill({
  icon,
  children,
  variant = "neutral",
  maxWidth = "max-w-[100px]",
  className = "",
  toneClassName,
  title,
}: PillProps) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ui-type-note ${
        toneClassName ?? variantClasses[variant]
      } ${className}`}
    >
      {icon}
      <span className={`truncate ${maxWidth}`}>{children}</span>
    </span>
  );
}