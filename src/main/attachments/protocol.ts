/**
 * 会话图片附件协议
 *
 * 渲染层用 `nova-attachment://<sessionId>/<file>` 直接作为 <img src>：
 * 浏览器按需读取、不经过 IPC、也不会再塞进会话 JSON。
 *
 * 必须在 app ready 之前调用 registerSchemesAsPrivileged（见 main/index.ts），
 * 否则自定义 scheme 不具备 standard/secure 语义，URL 解析与加载都会失败。
 */

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { protocol } from "electron";
import { resolveImageRef } from "./store";

export const ATTACHMENT_SCHEME = "nova-attachment";

export function registerAttachmentProtocol(): void {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // nova-attachment://<sessionId>/<filename>
    let filename: string;
    try {
      filename = decodeURIComponent(url.pathname.replace(/^\//, ""));
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    const ref = `${url.hostname}/${filename}`;
    const resolved = await resolveImageRef(ref);
    if (!resolved) return new Response("Not Found", { status: 404 });

    const stream = Readable.toWeb(createReadStream(resolved.file));
    return new Response(stream as unknown as BodyInit, {
      headers: {
        "content-type": resolved.mediaType,
        // 文件名是内容哈希，可以长期缓存
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });
}
