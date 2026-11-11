/**
 * Shiki 代码高亮 — 单例管理（精简版）
 *
 * 改用 `shiki/core` + 显式语言清单：
 * - `shiki` 全量入口会为每个语言注册表生成动态 chunk（此前构建里有 270+ 个
 *   lang-*.js），只有用到的语言才会被 Webpack/Rollup 打进产物。
 * - 这里只显式引入常用语言 + 皮肤声明的主题，产物里不再出现其余语言的
 *   语法文件，JS 总量和首屏解析成本都显著下降。
 *
 * 对外 API（getHighlighter / highlightCodeSync / isHighlighterReady）保持不变，
 * 调用方无需改动。
 */

import {
  createHighlighterCore,
  createOnigurumaEngine,
  type HighlighterCore,
} from "shiki/core";

// 主题：皮肤注册表里出现过的 codeTheme 对应到打包进产物的一组
import githubDark from "shiki/themes/github-dark.mjs";
import githubLight from "shiki/themes/github-light.mjs";

// 语言：只引入界面真正会用到的一小部分；用到的语法随主包走，
// 不再按需拉取 270+ 个独立 chunk
import python from "shiki/langs/python.mjs";
import javascript from "shiki/langs/javascript.mjs";
import typescript from "shiki/langs/typescript.mjs";
import tsx from "shiki/langs/tsx.mjs";
import jsx from "shiki/langs/jsx.mjs";
import bash from "shiki/langs/bash.mjs";
import shell from "shiki/langs/shell.mjs";
import json from "shiki/langs/json.mjs";
import html from "shiki/langs/html.mjs";
import css from "shiki/langs/css.mjs";
import go from "shiki/langs/go.mjs";
import rust from "shiki/langs/rust.mjs";
import java from "shiki/langs/java.mjs";
import c from "shiki/langs/c.mjs";
import cpp from "shiki/langs/cpp.mjs";
import sql from "shiki/langs/sql.mjs";
import yaml from "shiki/langs/yaml.mjs";
import markdown from "shiki/langs/markdown.mjs";
import xml from "shiki/langs/xml.mjs";
import diff from "shiki/langs/diff.mjs";

/**
 * shiki 的 lang 模块有时导出的是语言对象数组（`[lang]`），
 * 统一取第一个元素再交给核心，避免拿到数组报错。
 */
function unwrap<T>(module: T | T[]): T {
  return Array.isArray(module) ? module[0] : module;
}

const THEMES = {
  "github-dark": githubDark,
  "github-light": githubLight,
};

const LANGS = [
  python, javascript, typescript, tsx, jsx,
  bash, shell, json, html, css,
  go, rust, java, c, cpp, sql,
  yaml, markdown, xml, diff,
].map(unwrap);

let highlighter: HighlighterCore | null = null;
let initPromise: Promise<HighlighterCore> | null = null;

/**
 * 高亮结果缓存（LRU）。
 *
 * CodeBlock 在挂载时同步高亮：切换会话会把整个消息窗口重新挂载，同一段代码
 * 会被反复 tokenize；代码块多的会话里这部分会叠加成明显的切换卡顿。
 * 缓存按「主题 + 语言 + 源码」命中，切回看过的会话 / 反复换肤都不再重算。
 */
const HIGHLIGHT_CACHE_MAX_ENTRIES = 160;
const HIGHLIGHT_CACHE_MAX_CHARS = 2_000_000;
const highlightCache = new Map<string, string>();
let highlightCacheChars = 0;

function readHighlightCache(key: string): string | undefined {
  const hit = highlightCache.get(key);
  if (hit === undefined) return undefined;
  // LRU：命中后移到队尾
  highlightCache.delete(key);
  highlightCache.set(key, hit);
  return hit;
}

function writeHighlightCache(key: string, html: string): void {
  highlightCacheChars += key.length + html.length;
  highlightCache.set(key, html);
  while (
    highlightCache.size > HIGHLIGHT_CACHE_MAX_ENTRIES ||
    highlightCacheChars > HIGHLIGHT_CACHE_MAX_CHARS
  ) {
    const oldestKey = highlightCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = highlightCache.get(oldestKey);
    highlightCache.delete(oldestKey);
    highlightCacheChars -= oldestKey.length + (oldest?.length ?? 0);
  }
}

/** 获取 Shiki 高亮器（单例）。首次调用会异步初始化，后续直接返回缓存 */
export function getHighlighter(): Promise<HighlighterCore> {
  if (highlighter) return Promise.resolve(highlighter);
  if (initPromise) return initPromise;

  initPromise = createHighlighterCore({
    themes: [...new Set(Object.values(THEMES))],
    langs: LANGS,
    engine: createOnigurumaEngine(() => import("shiki/wasm")),
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

    const key = `${safeTheme}\u0000${safeLang}\u0000${code}`;
    const cached = readHighlightCache(key);
    if (cached !== undefined) return cached;

    const html = highlighter.codeToHtml(code, { lang: safeLang, theme: safeTheme });
    writeHighlightCache(key, html);
    return html;
  } catch {
    return null;
  }
}

/** 是否已初始化完成 */
export function isHighlighterReady(): boolean {
  return highlighter !== null;
}