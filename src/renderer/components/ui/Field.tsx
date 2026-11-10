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

/**
 * 输入框外观：按「宽度」与「密度」组合。
 *
 * - form：页面表单，13px + 设计 token 内边距；
 * - compact：工作流编辑器等紧凑面板，14px + 固定内边距。
 *
 * 宽度单独控制，避免再出现「先拼 w-full 再用正则删掉」的写法。
 */
export function inputClass({
  width = "full",
  density = "form",
}: {
  width?: "full" | "auto";
  density?: "form" | "compact";
} = {}): string {
  const widthClass = width === "full" ? "w-full" : "";
  const densityClass =
    density === "form"
      ? "px-inset py-inset ui-type-body"
      : "px-3 py-2 ui-type-item";
  return `ui-ring rounded-lg bg-input-bg text-text placeholder-text-muted outline-none transition-colors focus:border-input-border-focus ${widthClass} ${densityClass}`.trim();
}

/** 页面表单的默认输入框（撑满宽度） */
export const FORM_INPUT_CLASS = inputClass();

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
      <div className="mb-1.5 flex shrink-0 items-center gap-1 ui-type-label text-text-secondary">
        {label}
        {required && <span className="text-error">*</span>}
      </div>
      {children}
      {hint && (
        <p className="mt-1 shrink-0 ui-type-note leading-relaxed text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
