/**
 * 表单字段：标签 + 控件 + 说明
 *
 * 头像、MCP、员工等表单共用，避免各页面各写一份同样的小组件。
 */

import type {
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";

/** 表单输入框统一外观（input / select / textarea 共用） */
export const FORM_INPUT_CLASS =
  "ui-ring w-full rounded-lg bg-input-bg px-inset py-inset text-body text-text placeholder-text-muted outline-none transition-colors focus:border-input-border-focus";

/** 列表行内联重命名输入框（与完整表单的 36px 输入框区分） */
export const INLINE_INPUT_CLASS =
  "ui-ring min-w-0 flex-1 rounded-md border border-input-border bg-input-bg px-2 py-1 text-text outline-none transition-colors focus:border-input-border-focus";

/** 单行输入框：外观固定，宽度默认撑满（固定宽度用外层 div 控制） */
export function TextInput({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${FORM_INPUT_CLASS} ${className}`.trim()} {...props} />;
}

/** 多行输入框 */
export function TextArea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea className={`${FORM_INPUT_CLASS} ${className}`.trim()} {...props} />
  );
}

export function Field({
  label,
  hint,
  required,
  className = "",
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  /** 额外类名：需要字段撑满剩余高度时传 flex-1 */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className.trim()}>
      <div className="mb-1.5 flex shrink-0 items-center gap-1 text-meta font-medium text-text-secondary">
        {label}
        {required && <span className="text-error">*</span>}
      </div>
      {children}
      {hint && (
        <p className="mt-1 shrink-0 text-meta leading-relaxed text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
