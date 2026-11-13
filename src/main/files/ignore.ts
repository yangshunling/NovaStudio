/**
 * 文件树与文件监听共用的忽略规则。
 *
 * 两处必须保持一致：列目录时跳过的目录，监听时也不能上报事件，
 * 否则 `node_modules` 里装一次依赖会淹没真正的变更。
 */

/** 忽略的目录名（常见依赖 / 构建产物 / 编辑器目录） */
export const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  "coverage",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
]);

/** 忽略的文件前缀 */
export const IGNORED_FILE_PREFIXES = [".DS_Store"];

/** 该名字是否不需要出现在文件树里 */
export function isIgnoredName(name: string): boolean {
  return (
    IGNORED_DIR_NAMES.has(name) ||
    IGNORED_FILE_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}
