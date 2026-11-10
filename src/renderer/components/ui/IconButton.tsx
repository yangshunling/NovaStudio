/**
 * 圆形图标按钮
 *
 * 所有「只有图标」的操作入口都用它：新建 / 刷新 / 关闭 / 重试 / 危险操作。
 * 尺寸、hover、按下反馈与禁用态在这里统一，调用方只关心图标与动作。
 */

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type IconButtonSize = "xs" | "sm" | "md" | "icon";

const SIZE_CLASS: Record<IconButtonSize, string> = {
  xs: "h-7 w-7",
  sm: "h-8 w-8",
  md: "h-9 w-9",
  /** 跟随 --c-size-icon-btn（聊天 / 终端顶栏） */
  icon: "size-icon-btn",
};

export type IconButtonTone = "default" | "muted" | "accent" | "danger";

const TONE_CLASS: Record<IconButtonTone, string> = {
  /** 继承 .ui-btn-round 的默认文字色 */
  default: "",
  muted: "text-text-muted",
  accent: "text-text-muted hover:text-accent",
  danger: "text-text-muted hover:bg-error-bg hover:text-error",
};

const BASE_CLASS =
  "ui-btn-round ui-icon-action flex shrink-0 items-center justify-center rounded-full transition-colors active:scale-95 disabled:cursor-not-allowed disabled:opacity-40";

interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: ReactNode;
  /** 可读名称，同时作为 title / aria-label；调用方也可显式覆盖 */
  label: string;
  size?: IconButtonSize;
  tone?: IconButtonTone;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      icon,
      label,
      size = "md",
      tone = "default",
      className = "",
      type = "button",
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        title={label}
        aria-label={label}
        {...rest}
        className={`${BASE_CLASS} ${SIZE_CLASS[size]} ${TONE_CLASS[tone]} ${className}`.trim()}
      >
        {icon}
      </button>
    );
  },
);
