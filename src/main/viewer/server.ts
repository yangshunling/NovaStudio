/**
 * Office 查看器静态资源服务
 *
 * 为什么不用自定义协议承载查看器页面：
 * - Worker 脚本必须与页面同源，而主窗口运行在 file:// 源上；
 * - Electron 31 里非网络协议的 Worker 请求会绕过 protocol.handle
 *   （electron/electron#55111，44/45 才修复），即使注册 nova-viewer://，
 *   Worker 主脚本与后续请求也拿不到处理器；
 * - 因此在本机回环地址上起一个随机端口的 HTTP 服务，让查看器页面、
 *   Worker、WASM 全部落在标准的 http 源下。
 *
 * 安全边界：
 * - 只绑定 127.0.0.1，端口随机，路径再带一枚随机令牌；
 * - 只服务查看器入口、拆包 assets 与 File Viewer 运行时资源；
 * - 工作区文档不经过这里，仍由 nova-preview:// 按项目路径鉴权读取；
 * - iframe 不加载 preload，拿不到 IPC。
 */

import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { app } from "electron";
import { isInside } from "../utils/paths";

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  wasm: "application/wasm",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
};

let server: Server | null = null;
let baseUrl = "";

/** 查看器页面基址（`http://127.0.0.1:<port>/<token>`）；未启动时为空串 */
export function getViewerBaseUrl(): string {
  return baseUrl;
}

function contentTypeFor(filePath: string): string {
  const extension = extname(filePath).slice(1).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not Found");
}

/**
 * 只读取 root 内的普通文件。
 * rel 来自 URL，必须先过 isInside 再 stat，防止 ../ 逃出资源目录。
 */
async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  relativePath: string,
): Promise<void> {
  const fullPath = resolve(root, relativePath);
  if (!isInside(root, fullPath)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  let size: number;
  try {
    const info = await stat(fullPath);
    if (!info.isFile()) {
      notFound(response);
      return;
    }
    size = info.size;
  } catch {
    notFound(response);
    return;
  }

  /*
   * 端口与令牌每次启动都变，缓存键因此天然区分版本；带 hash 的资源
   * 可以长缓存，查看器入口 HTML 不缓存，保证升级后立即生效。
   */
  response.writeHead(200, {
    "content-type": contentTypeFor(fullPath),
    "content-length": String(size),
    "cache-control": fullPath.endsWith(".html")
      ? "no-store"
      : "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(fullPath).pipe(response);
}

export async function startViewerServer(): Promise<string> {
  if (server) return baseUrl;

  const token = randomBytes(24).toString("hex");
  const routePrefix = `/${token}/`;
  const rendererRoot = join(__dirname, "../renderer");
  const assetsRoots = {
    standard: join(
      app.getAppPath(),
      "node_modules/@file-viewer/assets-standard/viewer",
    ),
    ppt: join(
      app.getAppPath(),
      "node_modules/@file-viewer/assets-ppt/viewer",
    ),
  };
  let boundPort = 0;

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }

    // 防 DNS rebinding：只接受直接访问 127.0.0.1:<port> 的请求
    if (boundPort > 0 && request.headers.host !== `127.0.0.1:${boundPort}`) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      );
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Bad Request");
      return;
    }
    if (!pathname.startsWith(routePrefix)) {
      notFound(response);
      return;
    }
    const relativePath = pathname.slice(routePrefix.length);

    if (relativePath.startsWith("file-viewer/")) {
      const assetPath = relativePath.slice("file-viewer/".length);
      const root = assetPath.startsWith("vendor/ppt/")
        ? assetsRoots.ppt
        : assetsRoots.standard;
      await serveFile(request, response, root, assetPath);
      return;
    }
    if (relativePath.startsWith("viewer/")) {
      await serveFile(
        request,
        response,
        join(rendererRoot, "viewer"),
        relativePath.slice("viewer/".length),
      );
      return;
    }
    if (relativePath.startsWith("assets/")) {
      await serveFile(
        request,
        response,
        join(rendererRoot, "assets"),
        relativePath.slice("assets/".length),
      );
      return;
    }
    notFound(response);
  };

  const instance = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    instance.once("error", rejectPromise);
    instance.listen(0, "127.0.0.1", () => {
      instance.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = instance.address();
  if (!address || typeof address === "string") {
    instance.close();
    throw new Error("无法确定查看器服务端口");
  }

  boundPort = address.port;
  server = instance;
  baseUrl = `http://127.0.0.1:${boundPort}${routePrefix.slice(0, -1)}`;
  return baseUrl;
}

export function stopViewerServer(): void {
  if (!server) return;
  server.close();
  server = null;
  baseUrl = "";
}
