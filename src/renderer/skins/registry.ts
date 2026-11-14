/**
 * 皮肤注册表
 *
 * 自动收集 skins/<id>/index.ts 导出的 SkinVariant。
 * 新增一套皮肤 = 新增一个目录（index.ts + tokens.css），
 * 本文件、组件、代码高亮、设置面板、启动引导均无需改动。
 *
 * 顺序由 manifest.order 决定，与目录名顺序无关。
 */

import type { SkinVariant } from "@shared/contracts/skin";
import { DEFAULT_SKIN_ID } from "@shared/skin-default";

/** Vite 静态收集：每个皮肤目录导出自己的 variant */
const modules = import.meta.glob<{ variant: SkinVariant }>("./*/index.ts", {
  eager: true,
});

export const skins: readonly SkinVariant[] = Object.values(modules)
  .map((m) => m.variant)
  .sort((a, b) => a.order - b.order);

if (skins.length === 0) {
  throw new Error("未加载到任何皮肤，请检查 src/renderer/skins/<id>/index.ts");
}

/**
 * 默认皮肤：来自 shared 常量，而不是「目录顺序碰巧排第一」。
 * 缺失时仍回退 skins[0]，避免新增皮肤时因一次笔误导致白屏。
 */
export const defaultSkinId: string = skins.some((s) => s.id === DEFAULT_SKIN_ID)
  ? DEFAULT_SKIN_ID
  : skins[0].id;

if (import.meta.env.DEV && skins[0].id !== DEFAULT_SKIN_ID) {
  throw new Error(
    `默认皮肤不一致：registry 排首位的是 ${skins[0].id}，` +
      `shared/skin-default 声明的是 ${DEFAULT_SKIN_ID}`,
  );
}

/** 按 id 取皮肤；未知 id 回退默认皮肤（避免历史设置里的旧 id 导致白屏） */
export function getSkin(id: string): SkinVariant {
  return skins.find((s) => s.id === id) ?? skins[0];
}

/** 判断是否是已注册的皮肤 id */
export function hasSkin(id: string): boolean {
  return skins.some((s) => s.id === id);
}
