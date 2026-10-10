/**
 * 项目文件访问与只读预览
 *
 * 所有路径都从 projectId 对应的项目根目录解析，并在 realpath 后再次校验，
 * 防止 ../ 与符号链接逃逸到项目目录之外。
 */

import { open, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import type {
  FilePreview,
  FilePreviewKind,
  ReadFileResult,
} from "../../shared/types";
import * as db from "../db/sqlite";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_EMBED_BYTES = 25 * 1024 * 1024;

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  tiff: "image/tiff",
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

const TEXT_EXTENSIONS = new Set([
  ...Object.keys(CODE_LANGUAGES),
  "txt",
  "text",
  "log",
  "rtf",
  "lock",
  "license",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

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

    const imageMime = IMAGE_MIME_TYPES[extension];
    if (imageMime) {
      if (fileStat.size > MAX_EMBED_BYTES) {
        return {
          ok: true,
          file: binaryPreview(name, relativePath, mimeType, fileStat.size, "文件过大，未生成预览"),
        };
      }
      const buffer = await readFile(fullPath);
      return {
        ok: true,
        file: {
          name,
          relativePath,
          kind: "image",
          mimeType: imageMime,
          size: fileStat.size,
          dataUrl: `data:${imageMime};base64,${buffer.toString("base64")}`,
        },
      };
    }

    if (extension === "pdf") {
      if (fileStat.size > MAX_EMBED_BYTES) {
        return {
          ok: true,
          file: binaryPreview(name, relativePath, mimeType, fileStat.size, "文件过大，未生成预览"),
        };
      }
      const buffer = await readFile(fullPath);
      return {
        ok: true,
        file: {
          name,
          relativePath,
          kind: "pdf",
          mimeType,
          size: fileStat.size,
          dataUrl: `data:application/pdf;base64,${buffer.toString("base64")}`,
        },
      };
    }

    const knownText = TEXT_EXTENSIONS.has(extension);
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
    const kind: FilePreviewKind = MARKDOWN_EXTENSIONS.has(extension)
      ? "markdown"
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
  const project = db.getProject(projectId);
  if (!project?.cwd) throw new Error("项目不存在或未配置工作目录");

  const root = await realpath(project.cwd);
  const candidate = resolve(root, relativePath);
  if (!isInside(root, candidate)) throw new Error("文件路径超出项目目录");

  const fullPath = await realpath(candidate);
  if (!isInside(root, fullPath)) throw new Error("文件路径超出项目目录");
  return fullPath;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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

function resolveMimeType(name: string, extension: string): string {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower === "containerfile") return "text/plain";
  if (IMAGE_MIME_TYPES[extension]) return IMAGE_MIME_TYPES[extension];
  if (extension === "pdf") return "application/pdf";
  if (extension === "svg") return "image/svg+xml";
  if (TEXT_EXTENSIONS.has(extension)) return "text/plain";
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
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("ENOENT")) return "文件不存在";
  if (message.includes("EACCES") || message.includes("EPERM")) return "没有权限读取该文件";
  return message || "读取文件失败";
}
