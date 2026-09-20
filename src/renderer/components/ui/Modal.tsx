/**
 * 通用模态框骨架
 *
 * 统一处理：遮罩层 → 居中容器 → Esc 关闭 → 点击遮罩关闭。
 * 可选 size 控制尺寸（默认自适应内容）。
 */

import { useEffect } from "react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

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
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  widthClass = "w-[480px] max-w-[90vw]",
  size,
  className = "",
  children,
}: ModalProps) {
  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-bg/60 backdrop-blur-sm" />
      <div
        className={`ui-ring relative rounded-xl bg-surface shadow-[var(--c-shadow)] ${widthClass} ${className}`}
        style={size}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
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
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <h2 className="ui-serif text-title font-semibold text-text">{title}</h2>
      <button
        onClick={onClose}
        className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover hover:text-text"
        title="关闭"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}