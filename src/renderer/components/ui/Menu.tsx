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

import { createPortal } from "react-dom";
import type { ReactNode, RefObject } from "react";
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
  return createPortal(
    <div
      ref={menuRef}
      style={{ top: y, left: x, width }}
      className={`ui-dropdown-in ui-glass-strong ui-ring fixed z-[60] rounded-xl p-1.5 ${className}`.trim()}
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
