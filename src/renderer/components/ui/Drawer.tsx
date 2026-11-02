/**
 * 右侧抽屉骨架
 *
 * 统一处理：遮罩层 → 右侧面板 → Esc 关闭 → 点击遮罩关闭 → 焦点进入/归还。
 * 头部 / 正文 / 页脚由调用方按需组合：
 *
 *   <Drawer onClose={...} ariaLabel="MCP 服务">
 *     <DrawerHeader>…</DrawerHeader>
 *     <div className="min-h-0 flex-1 overflow-y-auto px-section py-card">…</div>
 *     <DrawerFooter>…</DrawerFooter>
 *   </Drawer>
 */

import { forwardRef, useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { isTopOverlay, popOverlay, pushOverlay } from "./overlayStack";

interface DrawerProps {
  onClose: () => void;
  /** 抽屉的可读名称 */
  ariaLabel: string;
  /** 面板宽度（Tailwind 类名），默认取布局 token */
  widthClass?: string;
  /** 额外面板类名 */
  className?: string;
  children: ReactNode;
}

export function Drawer({
  onClose,
  ariaLabel,
  widthClass = "w-[var(--c-layout-drawer)]",
  className = "",
  children,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef({});

  // onClose 每次渲染都是新函数，用 ref 持有，避免频繁重跑 effect
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const layer = layerRef.current;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    pushOverlay(layer);

    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) panel.focus();
    });
    // 只有最顶层浮层响应 Esc，避免一次按键关掉抽屉和它上面的确认框
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopOverlay(layer)) onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      popOverlay(layer);
      previous?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      onClick={onClose}
      role="presentation"
    >
      <div className="absolute inset-0 bg-bg/60 backdrop-blur-sm" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`ui-glass-strong relative flex h-full max-w-[94vw] flex-col border-l border-border-strong shadow-[var(--c-shadow)] outline-none ${widthClass} ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** 抽屉头部：固定高度、底部分隔线 */
export function DrawerHeader({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex h-[var(--c-layout-header)] shrink-0 items-center gap-3 border-b border-border px-section ${className}`}
    >
      {children}
    </div>
  );
}

/** 抽屉正文：可滚动区域，内边距与弹窗保持一致 */
export const DrawerBody = forwardRef<
  HTMLDivElement,
  { children: ReactNode; className?: string }
>(function DrawerBody({ children, className = "" }, ref) {
  return (
    <div
      ref={ref}
      className={`min-h-0 flex-1 overflow-y-auto px-section py-card ${className}`.trim()}
    >
      {children}
    </div>
  );
});

/** 抽屉页脚：固定在底部、顶部分隔线 */
export function DrawerFooter({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex shrink-0 items-center justify-between gap-3 border-t border-border px-section py-3 ${className}`}
    >
      {children}
    </div>
  );
}

/** 抽屉头部的关闭按钮，保证五个抽屉外观一致 */
export function DrawerCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      title="关闭"
      className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
    >
      <X className="h-4 w-4" />
    </button>
  );
}
