/**
 * 自定义下拉选择器
 *
 * 原生 <select> 的列表由操作系统渲染，无法跟随皮肤，深浅主题下都很突兀。
 * 这里用和右键菜单相同的一套浮层样式（ui-glass-strong + ui-dropdown-in），
 * 同时保留键盘操作：Enter / Space / ArrowDown 展开，方向键切换，Esc 关闭。
 *
 * 菜单挂到 body，避免被 Modal / Drawer 的 overflow 裁切。
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
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

/** 估算菜单高度，用于判断向上还是向下展开 */
function estimateMenuHeight(optionCount: number): number {
  return Math.min(optionCount * 36 + 12, 320);
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
    const width = Math.max(rect.width, minMenuWidth);
    const height = estimateMenuHeight(options.length);
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    // 下方放不下且上方空间更大时向上展开
    const top =
      spaceBelow < height + 8 && spaceAbove > spaceBelow
        ? Math.max(8, rect.top - height - 4)
        : rect.bottom + 4;

    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top,
      width,
    });
    setOpen(true);
  };

  // 外部点击 / Esc / 滚动 / 窗口缩放时关闭
  useEffect(() => {
    if (!open) return;

    const close = () => setOpen(false);
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    };
    // 只响应菜单外部的滚动，菜单自身的选项列表滚动不关闭
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

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
            className="ui-dropdown-in ui-glass-strong ui-ring fixed z-[60] overflow-y-auto rounded-xl p-1.5"
          >
            {options.length === 0 ? (
              <div className="px-2.5 py-2 text-meta text-text-muted">
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
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-meta transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      active
                        ? "bg-accent-soft font-medium text-accent"
                        : "text-text-secondary hover:bg-surface-hover hover:text-text"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {option.label}
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

