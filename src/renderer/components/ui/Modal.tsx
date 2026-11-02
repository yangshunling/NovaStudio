/**
 * 通用模态框骨架
 *
 * 统一处理：遮罩层 → 居中容器 → Esc 关闭 → 点击遮罩关闭 → 焦点进入/归还。
 * 可选 size 控制尺寸（默认自适应内容）。
 *
 * 这是底层容器：只负责遮罩、面板、Esc、焦点。标准「标题 + 内容 + 操作」
 * 结构请用上层 <Dialog>；左菜单 + 右内容这类自定义布局才直接用 Modal。
 * ModalHeader 的标题会自动登记为 role="dialog" 的可读名称。
 */

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { isTopOverlay, popOverlay, pushOverlay } from "./overlayStack";

/** ModalHeader 把标题 id 登记给最近的 Modal，供 aria-labelledby 使用 */
const ModalTitleContext = createContext<((id: string) => void) | null>(null);

interface ModalProps {
  /** 是否显示 */
  open: boolean;
  onClose: () => void;
  /** 容器宽度（Tailwind 类名），默认 w-[480px] */
  widthClass?: string;
  /** 容器自定义样式（可选） */
  size?: React.CSSProperties;
  /** 额外容器类名 */
  className?: string;
  /** 没有 ModalHeader 时用的可读名称（可选） */
  ariaLabel?: string;
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  widthClass = "w-[480px] max-w-[90vw]",
  size,
  className = "",
  ariaLabel,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef({});
  const [titleId, setTitleId] = useState<string | null>(null);

  // 入栈 / 出栈，保证 Esc 只关最顶层
  useEffect(() => {
    if (!open) return;
    const layer = layerRef.current;
    pushOverlay(layer);
    return () => popOverlay(layer);
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopOverlay(layerRef.current)) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 打开时把焦点交给弹窗，关闭时还给原来的元素。
  // 内部控件带 autoFocus 时以它为准，不抢焦点。
  useEffect(() => {
    if (!open) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) panel.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      previous?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-bg/60 backdrop-blur-sm" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : titleId ?? undefined}
        tabIndex={-1}
        className={`ui-glass-strong ui-ring relative flex max-h-[calc(100vh-48px)] flex-col overflow-y-auto rounded-2xl shadow-[var(--c-shadow)] outline-none ${widthClass} ${className}`}
        style={size}
        onClick={(e) => e.stopPropagation()}
      >
        <ModalTitleContext.Provider value={setTitleId}>
          {children}
        </ModalTitleContext.Provider>
      </div>
    </div>
  );
}

interface ModalHeaderProps {
  title: string;
  onClose: () => void;
  className?: string;
}

/** 模态框标题栏：左侧标题 + 右侧关闭按钮 */
export function ModalHeader({ title, onClose, className = "mb-4" }: ModalHeaderProps) {
  const titleId = useId();
  const registerTitle = useContext(ModalTitleContext);

  useEffect(() => {
    registerTitle?.(titleId);
  }, [registerTitle, titleId]);

  return (
    <div className={`flex items-center justify-between ${className}`}>
      <h2
        id={titleId}
        className="ui-serif text-title font-semibold text-text"
      >
        {title}
      </h2>
      <button
        type="button"
        onClick={onClose}
        className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
        title="关闭"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
