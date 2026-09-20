/**
 * 删除确认按钮
 *
 * 统一处理删除二次确认：点击垃圾桶 → 变确认勾（2.5s 超时自动复位）→ 点击执行。
 */

import { useState, useEffect } from "react";
import { Trash2, Check } from "lucide-react";

interface ConfirmDeleteButtonProps {
  onConfirm: () => void;
  /** 超时自动复位时间（毫秒），默认 2500 */
  timeoutMs?: number;
  title?: string;
  className?: string;
  iconSize?: number;
}

export function ConfirmDeleteButton({
  onConfirm,
  timeoutMs = 2500,
  title = "删除",
  className = "",
  iconSize = 16,
}: ConfirmDeleteButtonProps) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), timeoutMs);
    return () => clearTimeout(t);
  }, [confirming, timeoutMs]);

  const baseClass = `shrink-0 rounded p-1.5 transition-colors ${className}`;

  if (confirming) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          setConfirming(false);
          onConfirm();
        }}
        title="确认删除"
        className={`${baseClass} text-error hover:bg-error-bg`}
      >
        <Check size={iconSize} />
      </button>
    );
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        setConfirming(true);
      }}
      title={title}
      className={`${baseClass} text-text-muted hover:bg-error-bg hover:text-error`}
    >
      <Trash2 size={iconSize} />
    </button>
  );
}