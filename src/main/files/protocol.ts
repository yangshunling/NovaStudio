/**
 * 项目文件预览协议
 *
 * 渲染层用 `nova-preview://file/<文件名>?project=<id>&path=<相对路径>`
 * 作为 <img src> / <embed src>，由 Chromium 按需发起请求、主进程从磁盘
 * 流式返回，不再把整份文件转成 base64 塞进 IPC 与 React state。
 *
 * HTML 预览额外支持 `nova-preview://<projectId>/<相对路径>`：
 * iframe 里的相对资源引用会自然落到同一 host，从而仍指向同一个项目。
 *
 * 为什么不继续用 data URL：
 * - Chromium 的 URL 长度上限是 2MB（含 base64 膨胀 4/3），超过后图片 /
 *   PDF 会静默加载失败，预览区域只剩白框；
 * - PDF 查看器会按 Range 分段拉取，协议层支持 206 后才能边读边渲染。
 *
 * 必须在 app ready 之前调用 registerSchemesAsPrivileged（见 main/index.ts）。
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";
import { resolveMimeType, resolveProjectFile } from "./access";

export const PREVIEW_SCHEME = "nova-preview";

export function registerPreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    /*
     * 两种寻址方式：
     * - 旧式：nova-preview://file/<文件名>?project=<id>&path=<相对路径>
     *   图片 / PDF 由渲染层拼好完整路径后使用；
     * - 路径式：nova-preview://<projectId>/<相对路径>
     *   HTML 文档使用。项目 id 放在 host 上，页面里的 ./style.css 等相对
     *   引用解析后仍指向同一个 host，才能命中同一个项目。
     */
    let projectId: string | null = null;
    let relativePath: string | null = null;
    if (url.hostname === "file") {
      projectId = url.searchParams.get("project");
      relativePath = url.searchParams.get("path");
    } else {
      projectId = url.hostname;
      try {
        relativePath =
          url.pathname
            .split("/")
            .filter(Boolean)
            .map((segment) => decodeURIComponent(segment))
            .join("/") || null;
      } catch {
        // 非法的百分号编码
        return new Response("Bad Request", { status: 400 });
      }
    }
    if (!projectId || !relativePath) {
      return new Response("Bad Request", { status: 400 });
    }

    let fullPath: string;
    try {
      // resolveProjectFile 内部会 realpath 并校验仍在项目根目录内
      fullPath = await resolveProjectFile(projectId, relativePath);
    } catch {
      return new Response("Not Found", { status: 404 });
    }

    let size: number;
    try {
      const info = await stat(fullPath);
      if (!info.isFile()) return new Response("Not Found", { status: 404 });
      size = info.size;
    } catch {
      return new Response("Not Found", { status: 404 });
    }

    const name = basename(relativePath);
    const mimeType = resolveMimeType(name, extname(name).slice(1).toLowerCase());

    const headers: Record<string, string> = {
      "content-type": mimeType,
      "accept-ranges": "bytes",
      // 文件随时可能被外部编辑，不能沿用旧内容
      "cache-control": "no-store",
      // 渲染进程的页面基址是 dev server / 应用目录，fetch 该协议属于跨源
      "access-control-allow-origin": "*",
    };

    const range = parseRange(request.headers.get("range"), size);
    if (range) {
      const stream = createReadStream(fullPath, { start: range.start, end: range.end });
      return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
        status: 206,
        headers: {
          ...headers,
          "content-length": String(range.end - range.start + 1),
          "content-range": `bytes ${range.start}-${range.end}/${size}`,
        },
      });
    }

    const stream = createReadStream(fullPath);
    return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
      headers: { ...headers, "content-length": String(size) },
    });
  });
}

/** 只支持单段 Range（`bytes=start-end`），PDF 查看器实际只会发这种 */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  let start: number;
  let end: number;
  if (match[1] === "") {
    // 后缀范围：bytes=-N 表示最后 N 字节
    const suffix = Number(match[2]);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start > end || start >= size) return null;
  return { start, end };
}
