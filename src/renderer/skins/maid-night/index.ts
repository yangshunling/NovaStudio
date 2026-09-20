/**
 * 女仆工坊 · 夜（maid-night）
 *
 * 深海蓝底、柔金点缀、玻璃拟态。宫殿夜景 + 双立绘作为装饰舞台。
 * 美术资源授权 CC BY-NC-SA 4.0，署名信息见 resources/NOTICE.md（随包分发）。
 */

import "./tokens.css";
import palaceNight from "../../assets/maid/palace-night.webp";
import maidLeft from "../../assets/maid/maid-left.webp";
import maidRight from "../../assets/maid/maid-right.webp";
import type { SkinVariant } from "@shared/contracts/skin";

export const variant: SkinVariant = {
  id: "maid-night",
  displayName: "女仆工坊 · 夜",
  description: "深海蓝底、柔金点缀、玻璃拟态",
  appearance: "dark",
  codeTheme: "github-dark",
  preview: ["--c-bg", "--c-surface-2", "--c-accent", "--c-text", "--c-border"],
  order: 40,
  chrome: {
    background: palaceNight,
    left: maidLeft,
    right: maidRight,
  },
};
