/**
 * 资产卡片统一外观
 *
 * 员工 / 工作区 / 工作流 / 技能 / MCP / 触发器六类卡片结构不同，
 * 但外壳、标题层级、悬浮反馈与底栏间距必须保持一致。
 * 这里只收敛 class，卡片内部布局仍由各页面决定。
 */

/** 卡片外壳：统一最小高度、悬浮位移与阴影 */
export const CARD_SHELL =
  "group relative flex h-full min-h-36 flex-col rounded-xl border border-border bg-surface-2/60 p-card text-left shadow-[var(--c-shadow-sm)] transition-all hover:-translate-y-0.5 hover:border-border-strong hover:bg-surface-2/85 hover:shadow-[var(--c-shadow-sm)]";

/** 整卡可点击时补上光标（不可点击的卡片不要加） */
export const CARD_CLICKABLE = "cursor-pointer";

/** 卡片左上角的图标容器 */
export const CARD_ICON_TILE =
  "grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent";

/** 卡片标题 */
export const CARD_TITLE = "truncate text-title font-semibold text-text";

/** 卡片说明：两行截断，颜色统一为 muted */
export const CARD_DESCRIPTION =
  "line-clamp-2 text-body leading-relaxed text-text-muted";

/**
 * 卡片底栏：六类资产卡片（员工 / 技能 / MCP / 工作流 / 工作区 / 触发器）
 * 都必须是同一个底栏结构 —— 统一不带分隔线，只用留白拉开层次，元信息在左、操作在右。
 */

/** 只有元信息、没有操作的底栏 */
export const CARD_META =
  "mt-auto flex flex-wrap items-center gap-1.5 pt-3 text-meta text-text-muted";

/** 元信息 + 操作按钮的底栏 */
export const CARD_FOOTER =
  "mt-auto flex flex-wrap items-center justify-between gap-2 pt-3 text-meta text-text-muted";

/** 底栏左侧的元信息容器（用于 CARD_FOOTER 内） */
export const CARD_FOOTER_META =
  "flex min-w-0 flex-wrap items-center gap-1.5";
