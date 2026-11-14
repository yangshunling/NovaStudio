/**
 * 数字员工头像
 *
 * 有头像时展示图片；未设置时用名称首字兜底，避免列表里出现破图。
 * 头像以 data URL 存在 SQLite 中（上传时已裁剪为 256×256）。
 *
 * 外描边用 ring 而非 border：border-box 下 border 会吃掉 2px 内容区，
 * 与同尺寸的通用助手图片并排时会明显小一圈。ring 不占布局尺寸。
 */

import { Bot } from "lucide-react";
import type { DigitalEmployeeDraft } from "@shared/types";

export function EmployeeAvatar({
  employee,
  size = 56,
  className = "",
}: {
  employee: Pick<DigitalEmployeeDraft, "name" | "avatar">;
  size?: number;
  className?: string;
}) {
  const initial = employee.name.trim().slice(0, 1).toUpperCase();

  return (
    <span
      style={{ width: size, height: size }}
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-surface-2 ring-1 ring-border/60 ${className}`}
    >
      {employee.avatar ? (
        <img
          src={employee.avatar}
          alt={employee.name || "数字员工头像"}
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : initial ? (
        <span
          className="font-semibold text-accent"
          style={{ fontSize: Math.round(size * 0.4) }}
        >
          {initial}
        </span>
      ) : (
        <Bot
          className="text-text-muted"
          style={{ width: Math.round(size * 0.4), height: Math.round(size * 0.4) }}
        />
      )}
    </span>
  );
}
