/**
 * 图片载荷 → 可渲染 URL
 *
 * 新数据落库后只带 ref（`<sessionId>/att_<hash>.<ext>`），由主进程的
 * `nova-attachment://` 协议按需读取；旧数据 / 实时链路仍带 base64。
 * ref 优先，避免旧字段残留时把大图重新塞回 data URL。
 */
import type { ImagePayload } from "@shared/types";

export function imageSrc(image: ImagePayload): string | null {
  if (image.ref) return `nova-attachment://${image.ref}`;
  if (image.data) return `data:${image.mediaType};base64,${image.data}`;
  return null;
}
