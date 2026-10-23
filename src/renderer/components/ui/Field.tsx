/**
 * 表单字段：标签 + 控件 + 说明
 *
 * 头像、MCP、员工等表单共用，避免各页面各写一份同样的小组件。
 */

import type { ReactNode } from "react";

/** 表单输入框统一外观（input / select / textarea 共用） */
export const FORM_INPUT_CLASS =
  "ui-ring w-full rounded-lg bg-input-bg px-inset py-inset text-body text-text placeholder-text-muted outline-none transition-colors focus:border-input-border-focus";

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1 text-meta font-medium text-text-secondary">
        {label}
        {required && <span className="text-error">*</span>}
      </div>
      {children}
      {hint && (
        <p className="mt-1 text-meta leading-relaxed text-text-muted">{hint}</p>
      )}
    </div>
  );
}
