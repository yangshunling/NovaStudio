/**
 * 浮层焦点陷阱
 *
 * Modal / Drawer 只做「初始聚焦 + Esc + 焦点归还」还不够：Tab 会从
 * 弹窗最后一个控件跳到遮罩后的页面，键盘与读屏用户会迷失上下文。
 * 这里把 Tab / Shift+Tab 限制在面板内部，并只在最顶层浮层生效，
 * 避免嵌套确认框与抽屉同时响应。
 */

import { useEffect, type RefObject } from "react";
import { isTopOverlay } from "./overlayStack";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useFocusTrap(
  panelRef: RefObject<HTMLElement | null>,
  layer: object,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !isTopOverlay(layer)) return;

      const panel = panelRef.current;
      if (!panel) return;

      // 只取真正可见的控件：隐藏标签页 / 折叠区里的按钮不应参与循环
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => element.getClientRects().length > 0);

      if (focusables.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;

      if (event.shiftKey) {
        if (current === first || !panel.contains(current)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (current === last || !panel.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [panelRef, layer, active]);
}
