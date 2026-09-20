/**
 * 女仆工坊 · 昼（maid-day）
 *
 * 陶瓷白底、长春花蓝、柔金描边。宫殿日景 + 双立绘作为装饰舞台。
 * 美术资源授权 CC BY-NC-SA 4.0，署名信息见 resources/NOTICE.md（随包分发）。
 */

import "./tokens.css";
import palaceDay from "../../assets/maid/palace-day.webp";
import maidLeft from "../../assets/maid/maid-left.webp";
import maidRight from "../../assets/maid/maid-right.webp";
import type { SkinVariant } from "@shared/contracts/skin";

export const variant: SkinVariant = {
  id: "maid-day",
  displayName: "女仆工坊 · 昼",
  description: "陶瓷白底、长春花蓝、柔金描边",
  appearance: "light",
  codeTheme: "github-light",
  preview: ["--c-bg", "--c-surface-2", "--c-accent", "--c-text", "--c-border"],
  order: 30,
  chrome: {
    background: palaceDay,
    left: maidLeft,
    right: maidRight,
  },
};
