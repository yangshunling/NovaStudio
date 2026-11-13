/**
 * Claude Code 的消息输入编码
 *
 * 纯文本消息继续走默认的 text 输入格式（整段写 stdin 后关闭）。
 * 带图片时必须切到 --input-format stream-json：CLI 只在该格式下接受
 * content block 数组，图片以 Anthropic 的 image 块（base64）传递。
 *
 * 单独成文件是为了可测试：命令行参数怎么拼由 index.ts 负责，
 * 这里只回答「stdin 应该写什么」。
 */

import type { InputImage } from "../../../shared/types";

/** 有图片时才需要 stream-json 输入格式 */
export function usesStreamJsonInput(images?: InputImage[]): boolean {
  return !!images && images.length > 0;
}

/**
 * 把本轮正文与图片编码成 stream-json 的 user 消息（单行 NDJSON）。
 * 没有图片时返回原始正文，调用方继续使用 text 输入格式。
 */
export function buildUserInput(
  prompt: string,
  images?: InputImage[],
): string {
  if (!usesStreamJsonInput(images)) return prompt;

  const content: Record<string, unknown>[] = [];
  for (const image of images ?? []) {
    if (!image?.data || !image.mediaType) continue;
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType,
        data: image.data,
      },
    });
  }
  // 纯图片提问允许正文为空：不要再塞一个空 text 块
  if (prompt) content.push({ type: "text", text: prompt });

  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content },
  })}\n`;
}
