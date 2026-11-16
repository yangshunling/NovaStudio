/**
 * 标记文字（Badge）
 *
 * 统一 Agent/项目/状态的紧凑标记：描边小方块，不用实色药丸。
 * variant 只决定文字色，颜色仍表示语义（强调 / 成功 / 失败 / 警告）。
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
  accent: "border-accent/25 text-accent",
  neutral: "border-border text-text-muted",
  success: "border-success/25 text-success",
  error: "border-error/30 text-error",
  warning: "border-agent-amber/30 text-agent-amber",
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
      className={`inline-flex items-center gap-1 rounded-md border bg-transparent px-1.5 py-0.5 ui-type-sub ${
        toneClassName ?? variantClasses[variant]
      } ${className}`}
    >
      {icon}
      <span className={`truncate ${maxWidth}`}>{children}</span>
    </span>
  );
}