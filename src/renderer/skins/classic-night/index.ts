/**
 * 经典 · 夜（classic-night）
 *
 * 黑色调、GitHub 深蓝、夜间护眼。无装饰舞台。
 */

import "./tokens.css";
import type { SkinVariant } from "@shared/contracts/skin";

export const variant: SkinVariant = {
  id: "classic-night",
  displayName: "经典 · 夜",
  description: "黑色调、GitHub 深蓝、夜间护眼",
  appearance: "dark",
  codeTheme: "github-dark",
  preview: ["--c-bg", "--c-surface-2", "--c-accent", "--c-text", "--c-border"],
  order: 20,
  // 无 chrome：纯色皮肤不挂载装饰舞台
};
