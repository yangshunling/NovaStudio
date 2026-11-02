/**
 * 选项段按钮组
 *
 * 收敛「主从式单选/多选 chips」的重复样式。三处典型用法：
 *
 *   // 1. 配置项的单选段（字号、定时方式）：value 字符串，item.id 单选
 *   <OptionChips
 *     items={options}
 *     selected={value}
 *     onSelect={setValue}
 *     showCount          // 选中态在 chip 上展示计数
 *   />
 *
 *   // 2. 页面筛选（来源、星期）：selected 集合，可多选
 *   <OptionChips
 *     items={FILTERS}
 *     selected={selectedSet}     // Set<string> 或 string[]
 *     onToggle={(id) => toggle(id)}
 *     trailing={<span>说明</span>}
 *   />
 *
 * items: { id: string; label: ReactNode; count?: number }[]；item.id === "all"
 * 或 match "all" 的 id 不作为 key 冲突源；选中态 chip = accent-soft 强调，
 * 未选中 = surface-2 中性；可选 count 角标。
 *
 * 不适合：带详细描述的卡片式单选、自定义复杂内容——那些保留各自实现。
 */

import type { ReactNode } from "react";

export interface ChipItem {
  id: string | number;
  label: ReactNode;
  /** chip 右上角的小计数，不传则不显示 */
  count?: number;
  /** chip 是否禁用 */
  disabled?: boolean;
}

type ChipId = string | number;

interface BaseProps {
  items: ChipItem[];
  className?: string;
  /** 紧跟在 chips 后的说明，通常右对齐（如「只读来源可引用」） */
  trailing?: ReactNode;
  variant?: "pill" | "rect";
  /** pill 变体的内边距：sm（默认，筛选条）/ md（表单内选项） */
  size?: "sm" | "md";
}

interface SingleModeProps extends BaseProps {
  mode: "single";
  selected: ChipId;
  onSelect: (id: ChipId) => void;
}

interface MultiModeProps extends BaseProps {
  mode: "multi";
  selected: Set<ChipId> | ReadonlyArray<ChipId>;
  onToggle: (id: ChipId) => void;
}

export type OptionChipsProps = SingleModeProps | MultiModeProps;

const CHIPS_CONTAINER = "flex flex-wrap items-center gap-1.5";

export function OptionChips(props: OptionChipsProps) {
  const { items, className = "", trailing, variant = "pill", size = "sm" } = props;
  const isSelected = (id: ChipId) =>
    props.mode === "single"
      ? props.selected === id
      : props.selected instanceof Set
        ? props.selected.has(id)
        : props.selected.includes(id);

  const chipClass = (active: boolean) =>
    variant === "pill"
      ? `rounded-full text-meta transition-colors ${
          size === "sm" ? "px-2.5 py-1" : "px-3 py-1.5"
        } ${
          active
            ? "bg-accent-soft font-medium text-accent"
            : "bg-surface-2/60 text-text-secondary hover:bg-surface-hover hover:text-text"
        }`
      : `flex-1 rounded-lg px-3 py-2 text-body font-medium transition-colors ${
          active
            ? "bg-accent-soft text-accent shadow-[var(--c-shadow-sm)]"
            : "bg-surface-2/60 text-text-secondary hover:bg-surface-hover hover:text-text"
        }`;

  return (
    <div className={`${CHIPS_CONTAINER} ${className}`.trim()}>
      {items.map((item) => {
        const active = isSelected(item.id);
        const handleClick = () => {
          if (item.disabled) return;
          if (props.mode === "single") props.onSelect(item.id);
          else props.onToggle(item.id);
        };
        return (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            onClick={handleClick}
            className={chipClass(active)}
          >
            {item.label}
            {item.count !== undefined && (
              <span className="ml-1 opacity-70">{item.count}</span>
            )}
          </button>
        );
      })}
      {trailing && <span className="ml-auto text-meta text-text-muted">{trailing}</span>}
    </div>
  );
}