/**
 * 会话图片附件存储
 *
 * 图片只在落库时写盘，DB 里保存 `<sessionId>/att_<hash>.<ext>` 形式的 ref。
 * 目录放在会话运行时根下，删除会话时随 `removeSessionRuntime` 一并清理。
 *
 * ref 里带 sessionId 的目的是让渲染层无需知道「当前是哪条会话」就能拼出
 * `nova-attachment://` URL；读取时仍会校验两段格式，并用 realpath 确认
 * 文件没有逃出 attachments 目录。
 */

import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, ImagePayload } from "../../shared/types";
import { sessionRuntimeDir } from "../sessions/runtime";
import { isInsideReal } from "../utils/paths";

const ATTACHMENT_DIR = "attachments";

/** `<sessionId>/att_<hash>.<ext>`；两段都只允许安全字符 */
const REF_PATTERN =
  /^([A-Za-z0-9_-]+)\/(att_[a-f0-9]{24,64}\.(?:png|jpg|jpeg|webp|gif|avif|bmp|svg))$/;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/apng": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-icon": "png",
  "image/svg+xml": "svg",
};

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** 兼容误传的 data URL；正常路径是纯 base64 */
function stripDataUrl(data: string): string {
  if (!data.startsWith("data:")) return data;
  const comma = data.indexOf(",");
  return comma >= 0 ? data.slice(comma + 1) : "";
}

/**
 * 把一张图片写入会话附件目录，返回可落库的 ref。
 * 内容哈希命名天然去重；同一张图重复发送不会重复占盘。
 */
export async function saveImage(
  sessionId: string,
  image: { mediaType: string; data: string },
): Promise<string> {
  const ext = EXT_BY_MIME[image.mediaType];
  if (!ext) throw new Error(`不支持的图片类型：${image.mediaType}`);

  const base64 = stripDataUrl(image.data);
  if (!base64) throw new Error("图片内容为空");

  const hash = createHash("sha256")
    .update(base64, "utf8")
    .digest("hex")
    .slice(0, 32);
  const filename = `att_${hash}.${ext}`;
  const dir = join(sessionRuntimeDir(sessionId), ATTACHMENT_DIR);
  await mkdir(dir, { recursive: true });

  const file = join(dir, filename);
  try {
    await access(file);
  } catch {
    await writeFile(file, Buffer.from(base64, "base64"));
  }

  return `${sessionId}/${filename}`;
}

/** ref → 磁盘文件与 MIME；非法 / 越界 / 不存在时返回 null */
export async function resolveImageRef(
  ref: string,
): Promise<{ file: string; mediaType: string } | null> {
  const match = REF_PATTERN.exec(ref);
  if (!match) return null;

  const [, sessionId, filename] = match;
  const dir = join(sessionRuntimeDir(sessionId), ATTACHMENT_DIR);
  const file = join(dir, filename);
  if (!(await isInsideReal(dir, file))) return null;

  try {
    await access(file);
  } catch {
    return null;
  }

  const ext = filename.split(".").pop() ?? "";
  return {
    file,
    mediaType: MIME_BY_EXT[ext] ?? "application/octet-stream",
  };
}

/** 批量把事件里的图片转成 ref；单张失败时保留 base64，绝不丢消息 */
export async function externalizeImageEvents(
  sessionId: string,
  events: AgentEvent[],
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];

  for (const event of events) {
    if (event.type === "image") {
      if (!event.data) {
        out.push(event);
        continue;
      }
      try {
        const ref = await saveImage(sessionId, {
          mediaType: event.mediaType,
          data: event.data,
        });
        out.push({ type: "image", mediaType: event.mediaType, ref });
      } catch {
        out.push(event);
      }
      continue;
    }

    if (event.type === "tool_result" && event.images?.length) {
      const images = await Promise.all(
        event.images.map(async (item): Promise<ImagePayload> => {
          if (!item.data) return item;
          try {
            const ref = await saveImage(sessionId, {
              mediaType: item.mediaType,
              data: item.data,
            });
            return { mediaType: item.mediaType, ref };
          } catch {
            return item;
          }
        }),
      );
      out.push({ ...event, images });
      continue;
    }

    out.push(event);
  }

  return out;
}
