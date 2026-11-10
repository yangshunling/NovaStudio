/**
 * 浮层定位工具
 *
 * 下拉菜单与右键菜单共用：坐标收拢到视口内、按可用空间决定向上/向下展开。
 */

import { clamp } from "@shared/math";

/** 估算下拉菜单高度：36px 一行 + 12px 内边距，最多 320px */
export function estimateMenuHeight(optionCount: number): number {
  return Math.min(optionCount * 36 + 12, 320);
}

export interface PopupPlacement {
  left: number;
  top: number;
  width: number;
}

/**
 * 按锚点矩形计算浮层位置。
 *
 * 下方放不下且上方空间更大时向上展开；左右始终收拢在视口内。
 */
export function placePopup(
  anchor: Pick<DOMRect, "left" | "top" | "bottom" | "width">,
  {
    minWidth = 0,
    estimatedHeight = 0,
    gap = 4,
    margin = 8,
  }: {
    minWidth?: number;
    estimatedHeight?: number;
    gap?: number;
    margin?: number;
  } = {},
): PopupPlacement {
  const width = Math.max(anchor.width, minWidth);
  const spaceBelow = window.innerHeight - anchor.bottom;
  const spaceAbove = anchor.top;

  const top =
    spaceBelow < estimatedHeight + gap + 4 && spaceAbove > spaceBelow
      ? Math.max(margin, anchor.top - estimatedHeight - gap)
      : anchor.bottom + gap;

  return {
    left: clamp(anchor.left, margin, window.innerWidth - width - margin),
    top,
    width,
  };
}

/** 右键菜单：按鼠标坐标收拢到视口内 */
export function clampMenuPosition(
  x: number,
  y: number,
  {
    width,
    height,
    margin = 8,
  }: { width: number; height: number; margin?: number },
): { x: number; y: number } {
  return {
    x: clamp(x, margin, window.innerWidth - width - margin),
    y: clamp(y, margin, window.innerHeight - height - margin),
  };
}
