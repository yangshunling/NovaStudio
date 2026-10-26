/**
 * 数字员工编辑器的共用小件
 */

import { Plus, Trash2, type LucideIcon } from "lucide-react";

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={checked ? "已启用" : "已停用"}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border px-0.5 transition-colors ${
        checked
          ? "border-accent bg-accent"
          : "border-border-strong bg-surface-hover"
      }`}
    >
      {/* 用 flex 布局定位滑块，避免 absolute 的静态位置受按钮 text-align 影响 */}
      <span
        className={`h-3.5 w-3.5 rounded-full shadow-[var(--c-shadow-sm)] transition-transform ${
          checked
            ? "translate-x-4 bg-accent-foreground"
            : "translate-x-0 bg-text-secondary"
        }`}
      />
    </button>
  );
}

/**
 * 绑定动作：未绑定显示「添加」，已绑定显示「移除」。
 * 列表内联操作，避免「先点添加、再进弹窗选择」的二次跳转。
 */
export function BindAction({
  bound,
  onAdd,
  onRemove,
}: {
  bound: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  if (!bound) {
    return (
      <button
        type="button"
        onClick={onAdd}
        className="ui-btn-primary flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-meta font-medium"
      >
        <Plus className="h-3 w-3" />
        添加
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onRemove}
      title="从员工中移除"
      className="flex shrink-0 items-center gap-1 rounded-lg border border-error/25 bg-error-bg px-2.5 py-1.5 text-meta font-medium text-error transition-colors hover:bg-error/10"
    >
      <Trash2 className="h-3 w-3" />
      移除
    </button>
  );
}

export function EmptyTab({
  icon: Icon,
  text,
  hint,
}: {
  icon: LucideIcon;
  text: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-surface-2/30 px-6 py-14 text-center text-text-muted">
      <Icon className="h-7 w-7 opacity-50" />
      <p className="text-body text-text-secondary">{text}</p>
      {hint && <p className="text-caption">{hint}</p>}
    </div>
  );
}
