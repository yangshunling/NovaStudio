/**
 * 浮层关闭逻辑
 *
 * 统一处理：外部点击、Esc、浮层外滚动、窗口缩放。
 * 下拉菜单、右键菜单、弹出面板共用，避免每个调用方各写一份监听。
 */

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

export function useDismissableLayer(
  open: boolean,
  close: () => void,
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
  restoreFocus?: RefObject<HTMLElement | null>,
): void {
  // refs / close 每次渲染都可能是新引用；用 ref 保存，effect 只依赖 open
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;

    const isInside = (target: Node) =>
      refsRef.current.some((ref) => ref.current?.contains(target));

    const onDown = (event: MouseEvent) => {
      if (isInside(event.target as Node)) return;
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeRef.current();
      restoreFocus?.current?.focus();
    };
    // 只响应浮层外部的滚动，浮层自身的列表滚动不关闭
    const onScroll = (event: Event) => {
      if (isInside(event.target as Node)) return;
      closeRef.current();
    };
    const onResize = () => closeRef.current();

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, restoreFocus]);
}
