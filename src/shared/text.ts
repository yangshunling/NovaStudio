/**
 * 文本处理的跨进程纯函数
 *
 * 主进程读取文件与渲染进程比较编辑器内容都用同一份规则，
 * 避免两边对行尾的处理不一致导致「改回原样仍算有改动」。
 */

/** 统一换行符为 LF */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
