/**
 * 输入区的两条独立逻辑 —— 从 ChatArea 抽出
 *
 * - usePasteNormalizer：粘贴时还原段落结构（textarea 只认 text/plain）
 * - useComposerSubmit：发送、清空草稿、失败时回填正文与提示
 *
 * 留在 ChatArea 里的是布局、标签栏与各弹层的位置计算；这里只处理数据流，
 * 两条链路都可以脱离具体 DOM 结构单独推理。
 */

import { useCallback } from "react";
import type { ClipboardEvent } from "react";
import { toast } from "../../stores/toast";
import { toMessage } from "../../lib/utils";
import { htmlToPlainText, normalizeLineBreaks } from "../../lib/paste-text";
import type { MentionReference } from "./MentionPicker";
import type { InputImage } from "@shared/types";

/**
 * 粘贴时还原富文本的段落结构。
 *
 * textarea 只认剪贴板里的 text/plain；从网页 / Word 复制时，纯文本可能
 * 被拼成一行（换行只存在于 HTML 的 <p>/<br> 里），或使用 \v 之类非标准
 * 换行符。这里在需要时改用 HTML 重建文本，再交给输入框。
 */
export function usePasteNormalizer(
  setInput: (value: string) => void,
  onImages?: (files: File[]) => void,
) {
  return useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const clipboard = event.clipboardData;

      /*
       * 剪贴板里同时有图片和文字时（从网页复制图文），优先按图片处理：
       * 用户此时的意图通常是「贴图」，附带的那点 HTML 文本没有价值。
       *
       * 截图在部分平台上只出现在 items 里、不出现在 files 里，两边都取。
       */
      const fromItems: File[] = [];
      for (const item of Array.from(clipboard.items)) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) fromItems.push(file);
      }
      const imageFiles =
        fromItems.length > 0
          ? fromItems
          : Array.from(clipboard.files).filter((file) =>
              file.type.startsWith("image/"),
            );
      if (imageFiles.length > 0 && onImages) {
        event.preventDefault();
        onImages(imageFiles);
        return;
      }

      const plain = clipboard.getData("text/plain");
      const html = clipboard.getData("text/html");
      const normalized = normalizeLineBreaks(plain);

      let text: string | null = null;
      if (normalized !== plain && normalized.includes("\n")) {
        // Word 的软换行 / Unicode 行分隔符：先规整成普通换行
        text = normalized;
      } else if (html && !plain.includes("\n")) {
        // 纯文本没有换行时才用 HTML 重建，避免覆盖浏览器已经正确的粘贴结果
        const converted = htmlToPlainText(html);
        if (converted.includes("\n")) text = converted;
      }
      if (!text) return;

      event.preventDefault();
      try {
        if (document.execCommand("insertText", false, text)) return;
      } catch {
        // 命令不可用 / 被禁用时走下面的手工插入
      }

      // execCommand 不可用时的兜底：手动替换选区并恢复光标
      const textarea = event.currentTarget;
      const start = textarea.selectionStart ?? 0;
      const end = textarea.selectionEnd ?? 0;
      const next =
        textarea.value.slice(0, start) + text + textarea.value.slice(end);
      setInput(next);
      requestAnimationFrame(() => {
        textarea.focus();
        const caret = start + text.length;
        textarea.setSelectionRange(caret, caret);
      });
    },
    [setInput, onImages],
  );
}

/**
 * 发送：正文 + `@` 引用说明拼成完整 prompt。
 *
 * 引用说明各自成行（除文件 @path 外都是完整句子，挤在一行会连成一片）；
 * 展示正文只用用户亲手输入的部分，引用标签另行渲染。
 *
 * 失败处理：会话创建 / Agent 缺失等前置失败不会进入消息流，此时把正文和
 * `@` 引用一起还给用户并提示，避免重打正文、重挑文件。
 */
export function useComposerSubmit({
  input,
  images,
  references,
  clearReferences,
  restoreReferences,
  clearImages,
  restoreImages,
  setInput,
  pushHistory,
  sendMessage,
}: {
  input: string;
  images: InputImage[];
  references: MentionReference[];
  clearReferences: () => void;
  restoreReferences: (snapshot: MentionReference[]) => void;
  clearImages: () => void;
  restoreImages: (snapshot: InputImage[]) => void;
  setInput: (value: string) => void;
  pushHistory: (value: string) => void;
  sendMessage: (
    prompt: string,
    display?: string,
    images?: InputImage[],
  ) => Promise<void>;
}) {
  return useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed && references.length === 0 && images.length === 0) return;
    const referenceText = references
      .map((reference) => reference.promptText)
      .join("\n");
    const prompt = [trimmed, referenceText].filter(Boolean).join("\n");
    // 只记用户亲手输入的正文：引用说明是按引用标签拼出来的，回溯时无意义
    pushHistory(trimmed);
    // 快照要在清空之前取：失败时要连引用标签与图片一起还原
    const referenceSnapshot = references;
    const imageSnapshot = images;
    setInput("");
    clearReferences();
    clearImages();
    /*
     * 运行中发送不再被丢弃：chat store 会把它放进暂存区，
     * 本轮结束后按顺序发送。
     * 暂存区 / 纯图片消息需要一个可读标签，正文为空时用图片占位。
     */
    const display =
      trimmed ||
      referenceText ||
      (images.length > 0
        ? images.length > 1
          ? `[图片 ×${images.length}]`
          : "[图片]"
        : "");
    void sendMessage(prompt, display, images).catch((err) => {
      setInput(trimmed);
      restoreReferences(referenceSnapshot);
      restoreImages(imageSnapshot);
      toast.error(toMessage(err), 5000);
    });
  }, [
    input,
    images,
    references,
    clearReferences,
    restoreReferences,
    clearImages,
    restoreImages,
    setInput,
    pushHistory,
    sendMessage,
  ]);
}
