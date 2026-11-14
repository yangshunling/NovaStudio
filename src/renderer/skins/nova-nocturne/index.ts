/**
 * Nova · 夜（nova-nocturne）
 *
 * 深空石墨、星蓝紫强调色、三阶表面与内高光。
 */

import "./tokens.css";
import type { SkinVariant } from "@shared/contracts/skin";

export const variant: SkinVariant = {
  id: "nova-nocturne",
  displayName: "Nova · 夜",
  description: "深空石墨、星蓝紫、材质分层",
  appearance: "dark",
  codeTheme: "github-dark",
  // 排序最靠前 = 默认皮肤
  order: 1,
};
