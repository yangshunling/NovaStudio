/**
 * 项目文件访问与只读预览
 *
 * 所有路径都从 projectId 对应的项目根目录解析，并在 realpath 后再次校验，
 * 防止 ../ 与符号链接逃逸到项目目录之外。
 */

import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import type {
  FilePreview,
  FilePreviewKind,
  ReadEmbeddedImageResult,
  ReadFileResult,
} from "../../shared/types";
import * as db from "../db/sqlite";
import { isInside } from "../utils/paths";
import { errorMessage } from "../../shared/error";
import {
  isHtmlFile,
  isMarkdownFile,
  isSubtitleFile,
  isTextFile,
} from "../../shared/file-kinds";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_EMBED_BYTES = 25 * 1024 * 1024;

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  pjpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  tiff: "image/tiff",
  tif: "image/tiff",
  svg: "image/svg+xml",
};

/**
 * 音视频只收录 Chromium 内核能直接解码的容器。
 *
 * mkv / avi 等容器 Chromium 不支持，继续走 binary 兜底，由用户选择
 * 系统程序打开，避免预览区出现无法播放的黑框。
 */
const AUDIO_MIME_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/ogg",
  weba: "audio/webm",
};

const VIDEO_MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
};

/**
 * 字体：浏览器原生通过 FontFace 加载，不需要额外解析。
 * .eot 早已被 Chromium 移除，不收录。
 */
const FONT_MIME_TYPES: Record<string, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

/**
 * 预览 HTML 页面时，相对引用的样式 / 脚本 / 字体也要按正确 MIME 返回，
 * 否则 Chromium 会以 MIME 不匹配拒绝应用样式表或模块脚本。
 */
const WEB_MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  xhtml: "application/xhtml+xml; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
};

const CODE_LANGUAGES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  conf: "ini",
  config: "ini",
  env: "ini",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  py: "python",
  rb: "ruby",
  php: "php",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  sql: "sql",
  csv: "csv",
  tsv: "tsv",
};

export async function readProjectFile(
  projectId: string,
  relativePath: string,
): Promise<ReadFileResult> {
  try {
    const fullPath = await resolveProjectFile(projectId, relativePath);
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) {
      return { ok: false, error: "目标不是普通文件" };
    }

    const name = basename(fullPath);
    const extension = extname(name).slice(1).toLowerCase();
    const mimeType = resolveMimeType(name, extension);

    /*
     * 图片与 PDF 不再把内容读成 base64 data URL：
     * 1) Chromium 对 URL 长度有 2MB 上限，稍大的 PDF（base64 后超过 2MB）
     *    会整段加载失败，界面只剩一个白框；
     * 2) data URL 要经过 IPC 与 React state，文件越大主线程卡得越久。
     * 渲染层改用 nova-preview:// 按需流式读取（见 files/protocol.ts）。
     */
    /*
     * 音视频不进入文本 / 二进制判定：内容由 nova-preview:// 按需流式读取，
     * 这里只返回类型与元信息。协议层已支持 Range，可以拖动进度条。
     */
    if (AUDIO_MIME_TYPES[extension]) {
      return {
        ok: true,
        file: {
          name,
          relativePath,
          kind: "audio",
          mimeType: AUDIO_MIME_TYPES[extension],
          size: fileStat.size,
        },
      };
    }
    if (VIDEO_MIME_TYPES[extension]) {
      // 同目录下的同名 .vtt / .srt 自动挂到播放器上，省去手动选择字幕
      const subtitle = await findSiblingSubtitle(fullPath);
      return {
        ok: true,
        file: {
          name,
          relativePath,
          kind: "video",
          mimeType: VIDEO_MIME_TYPES[extension],
          size: fileStat.size,
          ...(subtitle
            ? {
                subtitlePath: siblingRelativePath(relativePath, subtitle.name),
                subtitleKind: subtitle.kind,
              }
            : {}),
        },
      };
    }

    if (FONT_MIME_TYPES[extension]) {
      return {
        ok: true,
        file: {
          name,
          relativePath,
          kind: "font",
          mimeType: FONT_MIME_TYPES[extension],
          size: fileStat.size,
        },
      };
    }

    /*
     * SVG 既是图片也是文本：返回渲染用的元信息，同时带上源码，
     * 让「渲染 / 源码」切换和 HTML 保持一致。
     */
    if (extension === "svg") {
      const truncated = fileStat.size > MAX_TEXT_BYTES;
      const buffer = await readPrefix(fullPath, MAX_TEXT_BYTES);
      return {
        ok: true,
        file: {
          name,
          relativePath,
          kind: "svg",
          mimeType: "image/svg+xml",
          size: fileStat.size,
          content: decodeText(buffer),
          truncated,
        },
      };
    }

    if (IMAGE_MIME_TYPES[extension] || extension === "pdf") {
      if (fileStat.size > MAX_EMBED_BYTES) {
        return {
          ok: true,
          file: binaryPreview(name, relativePath, mimeType, fileStat.size, "文件过大，未生成预览"),
        };
      }
      return {
        ok: true,
        file: {
          name,
          relativePath,
          kind: extension === "pdf" ? "pdf" : "image",
          mimeType,
          size: fileStat.size,
        },
      };
    }

    const knownText = isTextFile(name);
    if (!knownText && fileStat.size > MAX_TEXT_BYTES) {
      return {
        ok: true,
        file: binaryPreview(name, relativePath, mimeType, fileStat.size),
      };
    }

    const truncated = fileStat.size > MAX_TEXT_BYTES;
    const buffer = await readPrefix(fullPath, MAX_TEXT_BYTES);

    if (!knownText && looksBinary(buffer)) {
      return {
        ok: true,
        file: binaryPreview(name, relativePath, mimeType, fileStat.size),
      };
    }

    const content = decodeText(buffer);
    const kind: FilePreviewKind = isMarkdownFile(name)
      ? "markdown"
      : isHtmlFile(name)
        ? "html"
        : isSubtitleFile(name)
          ? "subtitle"
          : "text";

    return {
      ok: true,
      file: {
        name,
        relativePath,
        kind,
        mimeType: knownText ? mimeType : "text/plain",
        size: fileStat.size,
        language: resolveLanguage(extension),
        content,
        truncated,
      },
    };
  } catch (err) {
    return { ok: false, error: formatFileError(err) };
  }
}

export async function resolveProjectFile(
  projectId: string,
  relativePath: string,
): Promise<string> {
  const root = await projectRoot(projectId);
  const fullPath = await resolveInside(root, resolve(root, relativePath));
  return fullPath;
}

/**
 * 读取 Markdown 中引用的本地图片，按「所在文档目录」解析后转成 data URL。
 *
 * 渲染进程无法直接访问本地文件（页面基址是 dev server / 应用目录），
 * 因此相对路径图片必须由主进程读取并内联。
 */
export async function readEmbeddedImage(
  projectId: string,
  markdownPath: string,
  src: string,
): Promise<ReadEmbeddedImageResult> {
  try {
    const raw = src.trim();
    // 远程地址 / data URL / 协议相对地址交由渲染进程自己处理
    if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) {
      return { ok: false, error: "不是本地图片路径" };
    }

    // 去掉 ?query / #hash，并还原 %20 这类转义
    let pathPart = raw.split("#")[0].split("?")[0];
    try {
      pathPart = decodeURIComponent(pathPart);
    } catch {
      // 非法转义：按原文解析
    }
    if (!pathPart) return { ok: false, error: "图片路径为空" };

    const root = await projectRoot(projectId);
    const markdownFullPath = await resolveProjectFile(projectId, markdownPath);
    // 以 / 开头视为项目根目录，否则相对当前 Markdown 文件
    const base = pathPart.startsWith("/") ? root : dirname(markdownFullPath);
    const candidate = resolve(base, pathPart.replace(/^[/\\]+/, ""));
    const fullPath = await resolveInside(root, candidate);

    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) return { ok: false, error: "目标不是普通文件" };
    if (fileStat.size > MAX_EMBED_BYTES) {
      return { ok: false, error: "图片过大，无法内嵌预览" };
    }

    const extension = extname(fullPath).slice(1).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES[extension];
    if (!mimeType) return { ok: false, error: "不支持的图片格式" };

    const buffer = await readFile(fullPath);
    return {
      ok: true,
      mimeType,
      dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
    };
  } catch (err) {
    return { ok: false, error: formatFileError(err) };
  }
}

async function projectRoot(projectId: string): Promise<string> {
  const project = db.getProject(projectId);
  if (!project?.cwd) throw new Error("项目不存在或未配置工作目录");
  return realpath(project.cwd);
}

/** 校验候选路径（含符号链接解析结果）仍在项目根目录内 */
async function resolveInside(root: string, candidate: string): Promise<string> {
  if (!isInside(root, candidate)) throw new Error("文件路径超出项目目录");
  const fullPath = await realpath(candidate);
  if (!isInside(root, fullPath)) throw new Error("文件路径超出项目目录");
  return fullPath;
}

async function readPrefix(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

function decodeText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const first = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = first;
    }
    return swapped.toString("utf16le");
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return buffer.subarray(3).toString("utf8");
  }
  return buffer.toString("utf8");
}

function resolveLanguage(extension: string): string {
  return CODE_LANGUAGES[extension] ?? "text";
}

/**
 * 查找视频同目录下的字幕文件。
 *
 * 只认 `.vtt` / `.srt`：前者可以原样作为 `<track>`，后者渲染层会转成
 * WebVTT；`.ass` / `.ssa` 需要额外的样式解析，暂不自动挂载。
 * 精确同名（movie.srt）优先于带语言后缀（movie.zh.srt）。
 */
async function findSiblingSubtitle(
  fullPath: string,
): Promise<{ name: string; kind: "vtt" | "srt" } | null> {
  const dir = dirname(fullPath);
  const base = basename(fullPath, extname(fullPath));

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const candidates = names.filter((entry) =>
    /\.(vtt|srt)$/i.test(entry) &&
    entry.toLowerCase().startsWith(`${base.toLowerCase()}.`),
  );
  if (candidates.length === 0) return null;

  const score = (entry: string): number => {
    const suffix = entry.slice(base.length + 1).toLowerCase();
    return suffix.length * 10 + (suffix.endsWith("vtt") ? 0 : 1);
  };
  candidates.sort((a, b) => score(a) - score(b) || a.localeCompare(b));

  const chosen = candidates[0];
  return {
    name: chosen,
    kind: chosen.toLowerCase().endsWith(".vtt") ? "vtt" : "srt",
  };
}

/** 同目录文件 → 相对项目根路径；沿用原路径的分隔符习惯 */
function siblingRelativePath(relativePath: string, fileName: string): string {
  const index = Math.max(
    relativePath.lastIndexOf("/"),
    relativePath.lastIndexOf("\\"),
  );
  return index >= 0 ? relativePath.slice(0, index + 1) + fileName : fileName;
}

export function resolveMimeType(name: string, extension: string): string {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower === "containerfile") return "text/plain";
  if (IMAGE_MIME_TYPES[extension]) return IMAGE_MIME_TYPES[extension];
  if (AUDIO_MIME_TYPES[extension]) return AUDIO_MIME_TYPES[extension];
  if (VIDEO_MIME_TYPES[extension]) return VIDEO_MIME_TYPES[extension];
  if (FONT_MIME_TYPES[extension]) return FONT_MIME_TYPES[extension];
  if (extension === "pdf") return "application/pdf";
  if (extension === "svg") return "image/svg+xml";
  // WebVTT 必须按 text/vtt 返回，否则 <track> 会拒绝加载
  if (extension === "vtt") return "text/vtt";
  if (extension === "srt" || extension === "ass" || extension === "ssa") {
    return "text/plain";
  }
  if (WEB_MIME_TYPES[extension]) return WEB_MIME_TYPES[extension];
  if (isTextFile(name)) return "text/plain";
  return "application/octet-stream";
}

function binaryPreview(
  name: string,
  relativePath: string,
  mimeType: string,
  size: number,
  note?: string,
): FilePreview {
  return {
    name,
    relativePath,
    kind: "binary",
    mimeType,
    size,
    note,
  };
}

function formatFileError(err: unknown): string {
  const message = errorMessage(err);
  if (message.includes("ENOENT")) return "文件不存在";
  if (message.includes("EACCES") || message.includes("EPERM")) return "没有权限读取该文件";
  return message || "读取文件失败";
}
