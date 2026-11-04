/**
 * 分段页签 / 筛选器
 *
 * 详情页页签、运行记录筛选、员工抽屉标签统一使用这套：
 * 容器 rounded-xl + surface-hover，选中项浮起为 surface 背景。
 */

import type { ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
  /** 仅有图标时提供可读名称 */
  title?: string;
}

export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className = "",
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  /** sm：工具条内的紧凑尺寸（文件预览的图标切换等） */
  size?: "md" | "sm";
  className?: string;
}) {
  const compact = size === "sm";
  return (
    <div
      role="tablist"
      className={`flex flex-wrap items-center ${
        compact ? "gap-0.5 rounded-lg p-0.5" : "gap-1 rounded-xl p-1"
      } bg-surface-hover/60 ${className}`.trim()}
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={option.title}
            aria-label={option.title}
            onClick={() => onChange(option.id)}
            className={`flex items-center ${
              compact
                ? "gap-1 rounded-md px-2 py-1"
                : "gap-1.5 rounded-lg px-3 py-1.5"
            } text-meta font-medium transition-colors ${
              active
                ? "bg-surface text-text shadow-[var(--c-shadow-sm)]"
                : "text-text-muted hover:text-text"
            }`}
          >
            {option.icon}
            {option.label}
            {typeof option.count === "number" && (
              <span className="rounded-full bg-surface-hover px-1.5 text-caption">
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
