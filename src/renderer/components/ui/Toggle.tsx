/**
 * 通用开关
 *
 * 数字员工绑定、触发器启用等场景共用，放在设计系统层，
 * 避免 `employees/ui.tsx` 这类业务文件被其它页面反向依赖。
 */

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
