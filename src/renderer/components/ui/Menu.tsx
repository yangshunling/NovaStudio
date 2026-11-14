/**
 * 右键 / 下拉菜单
 *
 * 全站只有这一套菜单尺寸与菜单项样式：
 * - 容器：192px、圆角 xl、glass 背景、1.5 内边距
 * - 项：32px 高、圆角 md、ui-type-note、14px 图标
 *
 * 位置计算与外部点击关闭仍由调用方负责（各页面已有视口内收拢逻辑），
 * 这里只统一视觉与交互细节。
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MutableRefObject,
  ReactNode,
  RefObject,
} from "react";
import type { LucideIcon } from "lucide-react";

export const MENU_WIDTH = 192;

export function MenuPanel({
  x,
  y,
  width = MENU_WIDTH,
  menuRef,
  children,
  className = "",
}: {
  x: number;
  y: number;
  width?: number;
  menuRef?: RefObject<HTMLDivElement>;
  children: ReactNode;
  className?: string;
}) {
  const localRef = useRef<HTMLDivElement | null>(null);

  // 打开后把焦点交给第一项，键盘用户可直接用方向键浏览
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      localRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not([disabled])',
      ),
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") {
      next = (current - 1 + items.length) % items.length;
    } else if (event.key === "End") next = items.length - 1;
    items[next]?.focus();
  };

  return createPortal(
    <div
      ref={(node) => {
        localRef.current = node;
        if (menuRef) {
          (menuRef as MutableRefObject<HTMLDivElement | null>).current = node;
        }
      }}
      role="menu"
      aria-orientation="vertical"
      onKeyDown={handleKeyDown}
      style={{ top: y, left: x, width }}
      className={`ui-dropdown-in ui-glass-strong ui-ring ui-depth fixed z-[60] rounded-xl p-1.5 ${className}`.trim()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon: Icon,
  label,
  danger = false,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left ui-type-note transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
        danger
          ? "text-error hover:bg-error-bg"
          : "text-text-secondary hover:bg-surface-hover hover:text-text"
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}
