/**
 * 字体 token —— 与 skins/contract.ts 同一层的唯一真相来源
 *
 * 这里只维护「设置页有哪些字体选项、每个选项引用哪个 token」；
 * **字体栈本身写在 skins/_base.css**，组件与本文件都不重复字体串。
 * 因此调整某个字体只需要改 _base.css 的 token 值，所有引用处自动生效。
 *
 * 新增一个选项的步骤：
 *   1. _base.css 增加 --c-font-preset-<id> 及字体栈；
 *   2. contract.ts 的 OPTIONAL_TOKENS 登记同名 token；
 *   3. 本文件加一行 id / label / token。
 */

export interface FontPreset {
  id: string;
  label: string;
  /**
   * 该选项对应的 CSS 变量。
   * 系统默认直接用基础 token，切换时清掉内联覆盖即可。
   */
  token: string;
}

export const FONT_PRESETS: readonly FontPreset[] = [
  { id: "system", label: "系统默认", token: "--c-font-preset-system" },
  { id: "yahei", label: "微软雅黑", token: "--c-font-preset-yahei" },
  { id: "mono", label: "等宽", token: "--c-font-preset-mono" },
  {
    id: "source-han",
    label: "思源黑体",
    token: "--c-font-preset-source-han",
  },
  { id: "simsun", label: "宋体", token: "--c-font-preset-simsun" },
  { id: "kaiti", label: "楷体", token: "--c-font-preset-kaiti" },
];

/**
 * 字体 id → 需要写进 --c-font-sans 的变量引用。
 * 系统默认返回 null：清掉内联覆盖，交还给皮肤的基础字体栈。
 */
export function fontPresetToken(
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  const preset = FONT_PRESETS.find((item) => item.id === id);
  if (!preset || preset.id === "system") return null;
  return preset.token;
}

/** 设置页预览用：字体 id → 可直接放进 style 的 fontFamily 值 */
export function fontPresetPreview(id: string): string {
  const preset = FONT_PRESETS.find((item) => item.id === id);
  return preset ? `var(${preset.token})` : "var(--c-font-preset-system)";
}
