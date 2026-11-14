/**
 * 自定义下拉选择器
 *
 * 原生 <select> 的列表由操作系统渲染，无法跟随皮肤，深浅主题下都很突兀。
 * 这里用和右键菜单相同的一套浮层样式（ui-glass-strong + ui-dropdown-in），
 * 同时保留键盘操作：Enter / Space / ArrowDown 展开，方向键切换，Esc 关闭。
 *
 * 菜单挂到 body，避免被 Modal / Drawer 的 overflow 裁切。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { estimateMenuHeight, placePopup } from "../../lib/popup";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";

export interface SelectOption {
  value: string;
  label: string;
  /** 选项图标（头像 / 品牌图）；菜单与触发器都会展示 */
  icon?: ReactNode;
  /** 与名称同一行的补充说明（如工作区路径）；不传则只显示名称 */
  description?: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** 触发器样式（沿用各表单位置现有的输入框 class） */
  className?: string;
  /** 浮层最小宽度；默认 180，长选项可单独调大 */
  minMenuWidth?: number;
  title?: string;
  "aria-label"?: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "请选择",
  disabled = false,
  className = "",
  minMenuWidth = 180,
  title,
  "aria-label": ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);
  const label = selected?.label ?? placeholder;

  const openMenu = () => {
    if (disabled) return;
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    setPosition(
      placePopup(rect, {
        minWidth: minMenuWidth,
        estimatedHeight: estimateMenuHeight(options.length),
      }),
    );
    setOpen(true);
  };

  // 外部点击 / Esc / 滚动 / 窗口缩放时关闭
  useDismissableLayer(open, () => setOpen(false), [menuRef, triggerRef], triggerRef);

  // 展开后把焦点放到当前选项，方便直接用方向键切换
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const active =
      menuRef.current.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
      menuRef.current.querySelector<HTMLButtonElement>(
        '[role="option"]:not(:disabled)',
      );
    active?.focus();
  }, [open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();

    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]:not(:disabled)',
      ) ?? [],
    );
    if (items.length === 0) return;

    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? (current + 1) % items.length
        : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const pick = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" ||
            event.key === " " ||
            event.key === "ArrowDown"
          ) {
            event.preventDefault();
            if (!open) openMenu();
          }
        }}
        className={`flex items-center justify-between gap-2 text-left outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      >
        {selected?.icon && (
          <span className="flex shrink-0 items-center">{selected.icon}</span>
        )}
        <span
          className={`min-w-0 flex-1 truncate ${
            selected ? "" : "text-text-muted"
          }`}
        >
          {label}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            tabIndex={-1}
            data-nova-select-menu=""
            onKeyDown={handleMenuKeyDown}
            style={{
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: 320,
            }}
            className="ui-dropdown-in ui-glass-strong ui-ring ui-depth fixed z-[60] overflow-y-auto rounded-xl p-1.5"
          >
            {options.length === 0 ? (
              <div className="px-2.5 py-2 ui-type-note text-text-muted">
                暂无可选项
              </div>
            ) : (
              options.map((option) => {
                const active = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    disabled={option.disabled}
                    onClick={() => pick(option)}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left ui-type-note transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      active
                        ? "bg-accent-soft font-medium text-accent"
                        : "text-text-secondary hover:bg-surface-hover hover:text-text"
                    }`}
                  >
                    {option.icon && (
                      <span className="flex shrink-0 items-center">
                        {option.icon}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {option.label}
                      {option.description && (
                        <span
                          className={`ml-2 ${
                            active ? "text-accent/75" : "text-text-muted"
                          }`}
                        >
                          {option.description}
                        </span>
                      )}
                    </span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

