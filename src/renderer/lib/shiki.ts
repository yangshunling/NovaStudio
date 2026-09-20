/**
 * Shiki 代码高亮 — 单例管理
 *
 * Shiki 初始化较重（加载 WASM + 语法文件），全局只创建一次；首次调用时异步初始化，
 * 后续同步使用。
 *
 * 高亮主题由皮肤自己声明（SkinVariant.codeTheme），本模块只负责把注册表里
 * 出现过的主题一次性预加载，不做任何基于皮肤 id 的推断。
 */

import { createHighlighter, type Highlighter } from "shiki";
import { skins } from "../skins/registry";

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;

/** 预加载的常用语言 */
const PRELOAD_LANGS = [
  "python", "javascript", "typescript", "tsx", "jsx",
  "bash", "shell", "json", "html", "css",
  "go", "rust", "java", "c", "cpp", "sql",
  "yaml", "markdown", "xml", "diff",
];

/** 预加载的高亮主题：各皮肤声明过的主题之并集（新增皮肤自动带上） */
const PRELOAD_THEMES: string[] = Array.from(new Set(skins.map((s) => s.codeTheme)));

/** 获取 Shiki 高亮器（单例）。首次调用会异步初始化，后续直接返回缓存 */
export function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return Promise.resolve(highlighter);
  if (initPromise) return initPromise;

  initPromise = createHighlighter({
    themes: PRELOAD_THEMES,
    langs: PRELOAD_LANGS,
  }).then((h) => {
    highlighter = h;
    return h;
  });

  return initPromise;
}

/**
 * 同步高亮代码（高亮器已就绪时）。
 * 未就绪时返回 null，调用方需处理 fallback。
 *
 * @param codeTheme 高亮主题名，直接来自当前皮肤的 codeTheme
 */
export function highlightCodeSync(
  code: string,
  lang: string,
  codeTheme: string,
): string | null {
  if (!highlighter) return null;

  try {
    const loadedLangs = highlighter.getLoadedLanguages();
    const safeLang = loadedLangs.includes(lang) ? lang : "text";

    const loadedThemes = highlighter.getLoadedThemes();
    const safeTheme = loadedThemes.includes(codeTheme) ? codeTheme : loadedThemes[0];

    return highlighter.codeToHtml(code, { lang: safeLang, theme: safeTheme });
  } catch {
    return null;
  }
}

/** 是否已初始化完成 */
export function isHighlighterReady(): boolean {
  return highlighter !== null;
}
