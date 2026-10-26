/**
 * 可输入的下拉选择器（Combobox）
 *
 * 与 Select 共用一套浮层样式与交互习惯，区别是触发器本身是输入框：
 * - 聚焦 / 点击箭头展开全部候选项；
 * - 输入时按关键字过滤，仍可保留自定义值（适配自定义网关的模型名）；
 * - Enter 选中高亮项，Esc 关闭，方向和 Tab 键可正常操作。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { FORM_INPUT_CLASS } from "./Field";

export interface ComboboxOption {
  value: string;
  /** 省略时直接用 value 展示 */
  label?: string;
}

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<ComboboxOption>;
  placeholder?: string;
  /** 外层宽度类；输入框会自动占满 */
  className?: string;
  /** 浮层最小宽度；默认 180，长选项可单独调大 */
  minMenuWidth?: number;
  /** 展开下拉时触发，可用于按最新条件刷新候选项 */
  onOpen?: () => void;
  "aria-label"?: string;
}

/** 估算菜单高度，用于判断向上还是向下展开 */
function estimateMenuHeight(optionCount: number): number {
  return Math.min(optionCount * 36 + 12, 320);
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  className = "",
  minMenuWidth = 180,
  onOpen,
  "aria-label": ariaLabel,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  /** null = 未输入关键字，展示全部候选 */
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const visibleOptions = useMemo(() => {
    if (query === null) return options;
    const keyword = query.trim().toLowerCase();
    if (!keyword) return options;
    return options.filter((option) =>
      (option.label ?? option.value).toLowerCase().includes(keyword),
    );
  }, [options, query]);

  const openMenu = (resetQuery = true) => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const rect = wrapper.getBoundingClientRect();
    const width = Math.max(rect.width, minMenuWidth);
    const height = estimateMenuHeight(options.length);
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    const top =
      spaceBelow < height + 8 && spaceAbove > spaceBelow
        ? Math.max(8, rect.top - height - 4)
        : rect.bottom + 4;

    if (resetQuery) setQuery(null);
    setActiveIndex(0);
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top,
      width,
    });
    setOpen(true);
    onOpen?.();
  };

  const close = () => {
    setOpen(false);
    setQuery(null);
  };

  const pick = (option: ComboboxOption) => {
    onChange(option.value);
    close();
    inputRef.current?.focus();
  };

  // 外部点击 / Esc / 滚动 / 窗口缩放时关闭
  useEffect(() => {
    if (!open) return;

    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        wrapperRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        inputRef.current?.focus();
      }
    };
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

  // 候选列表变化时把高亮项收拢在范围内
  useEffect(() => {
    setActiveIndex((index) =>
      visibleOptions.length === 0
        ? 0
        : Math.min(index, visibleOptions.length - 1),
    );
  }, [visibleOptions]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      if (visibleOptions.length === 0) return;
      setActiveIndex((index) => {
        const step = event.key === "ArrowDown" ? 1 : -1;
        return (
          (index + step + visibleOptions.length) % visibleOptions.length
        );
      });
      return;
    }
    if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      const option = visibleOptions[activeIndex];
      if (option) pick(option);
      else close();
    }
  };

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          setQuery(next);
          setActiveIndex(0);
          // 输入后保持菜单展开，展示过滤结果
          if (!open) openMenu(false);
        }}
        onClick={() => {
          if (!open) openMenu();
        }}
        onKeyDown={handleKeyDown}
        className={`${FORM_INPUT_CLASS} pr-8`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="展开候选项"
        onClick={() => {
          if (open) close();
          else openMenu();
          inputRef.current?.focus();
        }}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            tabIndex={-1}
            data-nova-combobox-menu=""
            style={{
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: 320,
            }}
            className="ui-dropdown-in ui-glass-strong ui-ring fixed z-[60] overflow-y-auto rounded-xl p-1.5"
          >
            {visibleOptions.length === 0 ? (
              <div className="px-2.5 py-2 text-meta text-text-muted">
                无匹配项，可直接输入自定义值
              </div>
            ) : (
              visibleOptions.map((option, index) => {
                const display = option.label ?? option.value;
                const selected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => pick(option)}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-meta transition-colors ${
                      selected
                        ? "bg-accent-soft font-medium text-accent"
                        : index === activeIndex
                          ? "bg-surface-hover text-text"
                          : "text-text-secondary hover:bg-surface-hover hover:text-text"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{display}</span>
                    {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
