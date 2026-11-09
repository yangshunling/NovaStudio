/**
 * 经典 · 夜（classic-night）
 *
 * 黑色调、GitHub 深蓝、夜间护眼。
 */

import "./tokens.css";
import type { SkinVariant } from "@shared/contracts/skin";

export const variant: SkinVariant = {
  id: "classic-night",
  displayName: "经典 · 夜",
  description: "黑色调、GitHub 深蓝、夜间护眼",
  appearance: "dark",
  codeTheme: "github-dark",
  // 排序最靠前 = 默认皮肤：新装或未保存主题时进入夜间
  order: 5,
};
