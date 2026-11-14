/**
 * 默认皮肤的单一真值来源
 *
 * 三处必须一致，否则首次启动会出现「首帧一套皮肤、应用启动后另一套」的白闪：
 * 1. renderer 皮肤注册表（getSkin 的默认值）
 * 2. index.html 的首帧引导脚本（构建期由 electron.vite.config 注入）
 * 3. 主进程建窗时的 initialWindowBackground
 *
 * 运行时守卫见 scripts/verify-skin-tokens.mjs。
 */

export const DEFAULT_SKIN_ID = "nova-nocturne";

export const DEFAULT_SKIN_APPEARANCE = "dark" as const;

export const DEFAULT_WINDOW_BACKGROUND = "#0a0c11";
export const LIGHT_WINDOW_BACKGROUND = "#edeff4";
