/**
 * 元素是否真的在屏幕上可见。
 *
 * 用于文件监听：面板被切走时（父级 display:none / 标签页隐藏）不保留
 * 目录监听，避免后台空转。不能用 document.visibilityState —— 它只知道
 * 整个窗口是否最小化，不知道应用内部的页面切换。
 */

import { useEffect, useState, type RefObject } from "react";

export function useElementVisible(
  ref: RefObject<HTMLElement | null>,
): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return visible;
}
