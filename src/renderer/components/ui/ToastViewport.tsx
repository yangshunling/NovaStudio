/**
 * 全局 Toast 视口
 *
 * 固定在顶部居中、顶栏之下，避免遮住各页面的返回 / 保存等操作。
 * 只负责渲染与关闭，状态与时限由 stores/toast.ts 管理。
 */

import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useToastStore, type ToastTone } from "../../stores/toast";

const TONE_STYLE: Record<
  ToastTone,
  { icon: typeof CheckCircle2; className: string }
> = {
  success: { icon: CheckCircle2, className: "text-success" },
  error: { icon: AlertCircle, className: "text-error" },
  info: { icon: Info, className: "text-accent" },
};

export function ToastViewport() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <div
      aria-live="polite"
      // 顶栏高度随皮肤变化，用内联 calc 保证 + 号两侧有空格（CSS 规范要求）
      style={{ top: "calc(var(--c-layout-header) + 12px)" }}
      className="pointer-events-none fixed inset-x-0 z-[200] flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((item) => {
        const { icon: Icon, className } = TONE_STYLE[item.tone];
        return (
          <div
            key={item.id}
            role="status"
            className="ui-toast-in ui-glass-strong ui-ring pointer-events-auto flex w-fit max-w-[min(92vw,560px)] items-center gap-2.5 rounded-xl px-3.5 py-2 text-body text-text"
          >
            <Icon className={`h-4 w-4 shrink-0 ${className}`} />
            <span className="min-w-0 flex-1 break-words">{item.message}</span>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              title="关闭提醒"
              className="shrink-0 rounded p-0.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
