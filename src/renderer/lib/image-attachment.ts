/**
 * 图片附件预处理
 *
 * 剪贴板 / 文件选择拿到的是原始文件，直接 base64 透传有两个问题：
 * - 截图动辄 2~5MB，base64 再膨胀 33%，容易撞到接口的单图上限；
 * - 超过模型推荐长边（约 1568px）的像素不会带来更多信息，只增加 token。
 *
 * 这里统一缩放到长边 1568 再编码：照片保持 JPEG，其余走 PNG；
 * 仍然过大时再降级为 JPEG，最终按接口的 5MB 上限兜底报错。
 */

import type { InputImage } from "@shared/types";

/** file input 的 accept 属性 */
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

const SUPPORTED_TYPES = new Set(IMAGE_ACCEPT.split(","));
/** 长边上限：再大模型也会缩放，纯属浪费带宽与 token */
const MAX_EDGE = 1568;
/** 编码后原始字节上限：base64 后约 4.7MB，留出接口 5MB 的余量 */
const MAX_RAW_BYTES = 3.5 * 1024 * 1024;

export function isSupportedImage(file: File): boolean {
  return SUPPORTED_TYPES.has(file.type);
}

/** 读取图片尺寸；解码失败时给出可展示的错误 */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`无法读取图片「${file.name || "剪贴板图片"}」`));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("图片编码失败"))),
      type,
      quality,
    );
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 把一个图片文件编码成可随消息发送的附件。
 * 统一铺白底：JPEG 不支持透明，避免降级时透明区域变黑。
 */
export async function fileToInputImage(file: File): Promise<InputImage> {
  if (!isSupportedImage(file)) {
    throw new Error("仅支持 PNG / JPEG / WebP / GIF 图片");
  }

  const image = await loadImage(file);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error("图片尺寸异常，无法发送");

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境不支持图片处理");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  // 照片保留 JPEG；截图 / 图标用 PNG，文字边缘更清晰
  const preferredType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  let blob = await canvasToBlob(
    canvas,
    preferredType,
    preferredType === "image/jpeg" ? 0.92 : undefined,
  );
  if (blob.size > MAX_RAW_BYTES && blob.type !== "image/jpeg") {
    // PNG 压缩不了照片，降级 JPEG；白底已经铺好
    blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
  }
  if (blob.size > MAX_RAW_BYTES) {
    throw new Error("图片过大，请压缩后再发送");
  }

  return {
    mediaType: blob.type || preferredType,
    data: await blobToBase64(blob),
  };
}
