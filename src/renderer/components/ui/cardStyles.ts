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

/** 卡片底部标签 / 元信息行 */
export const CARD_META =
  "mt-auto flex flex-wrap items-center gap-1.5 pt-3 text-meta text-text-muted";

/** 卡片底部操作行（带分隔线） */
export const CARD_ACTION_FOOTER =
  "mt-auto flex items-center justify-between gap-2 border-t border-border pt-3";
