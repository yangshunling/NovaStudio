/**
 * 设置页布局骨架
 *
 * 所有设置面板统一为「页头 + 若干卡片 + 卡片内按行排列」：
 * - 页头说明这一组设置管什么，一句话；
 * - 卡片标题说明子领域，控件说明只留「生效时机 / 风险」这类短提示；
 * - 每行左侧名称 + 一行灰字，右侧是控件，避免纵向堆叠标题把页面拉长。
 */

import type { ReactNode } from "react";

/** 设置面板页头与内容容器 */
export function SettingsPage({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <h2 className="ui-type-heading text-text">{title}</h2>
        {description && (
          <p className="mt-1 ui-type-body text-text-muted">{description}</p>
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

/** 设置卡片：标题区 + 分隔线分隔的行 */
export function SettingsCard({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border">
      {(title || description) && (
        <div className="border-b border-border px-4 py-3">
          {title && (
            <h3 className="ui-type-body font-semibold text-text">{title}</h3>
          )}
          {description && (
            <p className="mt-0.5 ui-type-note text-text-muted">{description}</p>
          )}
        </div>
      )}
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

/**
 * 设置行：左侧名称 / 提示，右侧控件。
 *
 * hint 只写「改后何时生效」或「有什么代价」，不再铺陈背景说明。
 */
export function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="ui-type-body text-text">{label}</p>
        {hint && (
          <p className="mt-0.5 ui-type-note leading-relaxed text-text-muted">
            {hint}
          </p>
        )}
      </div>
      <div className="flex min-w-0 shrink-0 items-center justify-end gap-2">
        {children}
      </div>
    </div>
  );
}

/** 设置里的小号选项按钮（字号 / 预设值这类分段选择） */
export function OptionButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 ui-type-note transition-colors ${
        active
          ? "border-accent bg-accent-soft text-accent"
          : "border-border text-text-secondary hover:border-border-strong hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
