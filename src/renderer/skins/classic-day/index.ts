/**
 * 经典 · 昼（classic-day）
 *
 * 白色调、GitHub 蓝、简洁利落。无装饰舞台。
 */

import "./tokens.css";
import type { SkinVariant } from "@shared/contracts/skin";

export const variant: SkinVariant = {
  id: "classic-day",
  displayName: "经典 · 昼",
  description: "白色调、GitHub 蓝、简洁利落",
  appearance: "light",
  codeTheme: "github-light",
  preview: ["--c-bg", "--c-surface-2", "--c-accent", "--c-text", "--c-border"],
  order: 10,
  // 无 chrome：纯色皮肤不挂载装饰舞台
};
