/**
 * 通用按钮
 *
 * 所有按钮只通过语义调用，尺寸 / 圆角 / 间距 / 禁用态由 .ui-btn 基座统一，
 * 颜色由变体决定。不要再在业务里拼 ui-btn-* + 尺寸工具类。
 *
 *   <Button variant="primary" loading={saving} onClick={save}>保存</Button>
 *   <Button variant="dangerLink" size="sm" icon={<Trash2 />}>删除</Button>
 */

import { forwardRef } from "react";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "ghost" | "danger" | "dangerLink";
export type ButtonSize = "md" | "sm";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "ui-btn-primary",
  ghost: "ui-btn-ghost",
  danger: "ui-btn-danger",
  dangerLink: "ui-btn-danger-link",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 提交中：显示转圈并禁用 */
  loading?: boolean;
  /** 按钮图标（loading 时会被转圈替代） */
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "ghost",
    size = "md",
    loading = false,
    icon,
    disabled,
    className = "",
    children,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={`ui-btn ${VARIANT_CLASS[variant]} ${
        size === "sm" ? "ui-btn-sm" : ""
      } ${className}`.trim()}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});
