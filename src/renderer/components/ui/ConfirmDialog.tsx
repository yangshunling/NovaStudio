/**
 * 应用内确认框
 *
 * 由 `confirmDialog()` 驱动，App 顶层挂载一次即可。
 * 不用 `window.confirm()`：原生对话框关闭后会让窗口丢失键盘焦点（见 stores/confirm.ts）。
 */

import { useEffect, useRef } from "react";
import { Dialog, DialogActions } from "./Dialog";
import { Button } from "./Button";
import { useConfirmStore } from "../../stores/confirm";

export function ConfirmDialog() {
  const request = useConfirmStore((s) => s.request);
  const settle = useConfirmStore((s) => s.settle);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // 每个新请求都把焦点落到确认按钮：弹窗出现后键盘可以直接操作
  useEffect(() => {
    if (request) confirmRef.current?.focus();
  }, [request?.id]);

  if (!request) return null;

  const {
    title,
    message,
    confirmLabel = "确定",
    cancelLabel = "取消",
    tone = "default",
  } = request;

  return (
    <Dialog
      open
      onClose={() => settle(false)}
      title={title}
      widthClass="w-[440px] max-w-[90vw]"
    >
      {message && (
        <p className="whitespace-pre-line text-body-lg leading-relaxed text-text-secondary">
          {message}
        </p>
      )}

      <DialogActions>
        <Button onClick={() => settle(false)}>{cancelLabel}</Button>
        <Button
          ref={confirmRef}
          variant={tone === "danger" ? "danger" : "primary"}
          onClick={() => settle(true)}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
