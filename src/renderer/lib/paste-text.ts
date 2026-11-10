/**
 * 剪贴板文本规整
 *
 * 从网页 / Word / 邮件复制富文本时，浏览器给 text/plain 的换行经常不可靠：
 * - 段落只有 HTML 的 <p>/<br>，纯文本里被拼成一行；
 * - Word 用垂直制表符（\v）或 Unicode 行分隔符（U+2028 / U+2029）表示软换行。
 * 这里把这两种情况还原成普通的 \n，让粘贴进 textarea 后保留段落结构。
 */

/** 需要换行分隔的块级元素 */
const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TR",
  "UL",
]);

/** Word / 部分应用使用的非标准换行符 → \n */
export function normalizeLineBreaks(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/\u000b/g, "\n");
}

/**
 * HTML → 保留段落、列表与代码块结构的纯文本。
 *
 * 只保留文本结构与换行，不生成 Markdown 标记：聊天输入框最终是纯文本，
 * 用户看到的内容应当和粘贴前一致，而不是多出一堆 `**` / `#`。
 */
export function htmlToPlainText(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];

  /** 保证两项之间至少有一个换行（避免连续块产生大量空行） */
  const breakLine = () => {
    if (out.length > 0 && !out[out.length - 1].endsWith("\n")) out.push("\n");
  };

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      // HTML 里的缩进 / 折行不是内容，压成单个空格；<pre> 单独处理
      const text = (node.textContent ?? "").replace(/\s+/g, " ");
      if (text) out.push(text);
      return;
    }
    if (!(node instanceof HTMLElement)) return;

    const tag = node.tagName;
    if (tag === "BR") {
      out.push("\n");
      return;
    }
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return;
    if (tag === "PRE") {
      breakLine();
      out.push(node.textContent ?? "", "\n\n");
      return;
    }
    if (tag === "LI") {
      breakLine();
      out.push("- ");
      node.childNodes.forEach(walk);
      out.push("\n");
      return;
    }

    const block = BLOCK_TAGS.has(tag);
    if (block) breakLine();
    node.childNodes.forEach(walk);
    if (block) breakLine();
  };

  walk(document.body);

  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
