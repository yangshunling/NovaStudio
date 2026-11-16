/**
 * 资产卡片统一外观
 *
 * 员工 / 工作区 / 工作流 / 技能 / MCP / 触发器六类卡片结构不同，
 * 但外壳、标题层级、悬浮反馈与底栏间距必须保持一致。
 * 这里只收敛 class，卡片内部布局仍由各页面决定。
 */

/**
 * 卡片外壳：统一最小高度、描边与焦点环。
 *
 * 与待办 / 触发器卡片保持同一语言：中性表面 + 细描边。
 * hover 只加深描边，不位移、不投影，列表滚动时不会被「浮起」打断。
 */
/*
 * min-w-0 是必需的：卡片是 CSS Grid 的直接子项，而 grid 的 `1fr` 轨道最小宽度
 * 取 `auto`，一条不可换行的长命令 / 长路径会把整列撑宽、顶出可视区。
 * 把卡片自身的最小宽度归零，内部再用 truncate 截断，长文本才会显示省略号。
 */
export const CARD_SHELL =
  "ui-card-material group relative flex h-full min-h-32 min-w-0 flex-col items-stretch overflow-hidden rounded-xl border border-border p-card text-left transition-[translate,border-color,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[var(--c-shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

/**
 * 图标容器的分区色槽位。
 *
 * 一类资产固定一个低饱和色相：技能=苔绿、MCP=天蓝、工作区/知识库=青、
 * 提示词/触发器=琥珀、数字员工=玫红、工作流/Agent=品牌蓝。
 * 色相只出现在图标与关键读数上，不染卡片底色。
 */
const CARD_ICON_TONES = {
  accent: "text-accent",
  violet: "text-hue-moss",
  sky: "text-hue-sky",
  teal: "text-hue-teal",
  amber: "text-hue-amber",
  rose: "text-hue-rose",
} as const;

export type CardIconTone = keyof typeof CARD_ICON_TONES;

/** 卡片左上角的图标容器，统一 16px 单色（分区色） */
export function cardIconTile(tone: CardIconTone = "accent"): string {
  return `ui-tile grid h-8 w-8 shrink-0 place-items-center ${CARD_ICON_TONES[tone]}`;
}

/** 卡片标题 */
export const CARD_TITLE = "ui-type-title truncate text-text";

/** 卡片说明：两行截断，颜色统一为 muted */
export const CARD_DESCRIPTION =
  "line-clamp-2 ui-type-body leading-relaxed text-text-muted";

/**
 * 卡片底栏：六类资产卡片（员工 / 技能 / MCP / 工作流 / 工作区 / 触发器）
 * 都必须是同一个底栏结构 —— 统一不带分隔线，只用留白拉开层次，元信息在左、操作在右。
 */

/** 只有元信息、没有操作的底栏 */
export const CARD_META =
  "mt-auto flex flex-wrap items-center gap-1.5 pt-3 ui-type-note text-text-muted";

/** 元信息 + 操作按钮的底栏 */
export const CARD_FOOTER =
  "mt-auto flex flex-wrap items-center justify-between gap-2 pt-3 ui-type-note text-text-muted";
