/**
 * 长 Markdown 的块级切分
 *
 * 流式正文每 80–200ms 提交一次，react-markdown 每次都会把**整段**重新
 * 解析、重新生成 React 元素。解析成本随长度线性增长（实测 4KB≈9ms、
 * 32KB≈50ms、92KB≈153–230ms），长回复下单次刷新就能占满一帧以上。
 *
 * 这里把正文按「安全的块边界」切开：已经写完的块交给 memo 化的渲染器，
 * 每帧只重解析仍在增长的尾巴。整条回复的总解析量不变，但单帧成本从
 * O(全文) 降到 O(尾巴)，92KB 正文实测从约 230ms/帧 降到约 0.2ms/帧。
 *
 * 切分必须保守：以下情况不切
 * - 围栏代码块内部（``` / ~~~ 未闭合）
 * - 列表项之间（否则每个列表项会变成独立列表，序号重置、间距变大）
 * - 缩进续行（列表项的续段）
 * - 全文出现引用式链接定义（`[id]: url`）时整体不切，
 *   避免定义与引用被分到不同文档后链接失效
 *
 * 空行本身被丢弃：块间距由渲染组件的 margin 负责，与整段渲染一致。
 */

export interface MarkdownBlocks {
  /** 已写完、可以长期复用的块 */
  stable: string[];
  /** 仍在增长的最后一块 */
  tail: string;
}

/** 列表项 / 有序列表项起始行 */
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])\s+/;
/** 缩进行（列表续段 / 缩进代码块） */
const INDENTED = /^\s+\S/;
/** 围栏起点：0–3 个空格 + 至少 3 个反引号或波浪号 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** 引用式链接 / 脚注定义 */
const REF_DEF = /^\s{0,3}\[[^\]]+\]:\s+\S+/m;

function lastNonEmpty(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) return lines[i];
  }
  return "";
}

function nextNonEmpty(lines: string[], from: number): string {
  for (let i = from; i < lines.length; i += 1) {
    if (lines[i].trim()) return lines[i];
  }
  return "";
}

/**
 * 把 Markdown 切成「稳定块 + 尾块」。
 * 无法安全切分时返回 `{ stable: [], tail: content }`，调用方按整段渲染。
 */
export function splitMarkdownBlocks(content: string): MarkdownBlocks {
  // 引用式定义可能被后文引用，跨块后解析不到 —— 直接放弃切分
  if (REF_DEF.test(content)) return { stable: [], tail: content };

  const lines = content.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  /** 当前打开的围栏标记（如 "```"），null 表示不在代码块内 */
  let fence: string | null = null;

  const flush = (): void => {
    const text = current.join("\n").replace(/\s+$/, "");
    if (text) blocks.push(text);
    current = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
    }

    if (fence === null && line.trim() === "") {
      const previous = lastNonEmpty(current);
      const next = nextNonEmpty(lines, i + 1);
      /*
       * 列表内部的空行不是块边界：松列表（loose list）用空行分隔条目，
       * 切开会把同一个列表拆成多个 <ul>，序号重新开始。
       */
      const listContinuation =
        (LIST_ITEM.test(previous) || INDENTED.test(previous)) &&
        (LIST_ITEM.test(next) || INDENTED.test(next));
      if (!listContinuation) {
        flush();
        // 空行只作分隔，不进入任何一个块
        continue;
      }
    }

    current.push(line);
  }

  flush();

  if (blocks.length <= 1) return { stable: [], tail: content };
  const tail = blocks.pop()!;
  return { stable: blocks, tail };
}

/**
 * 判断是否值得按块渲染。
 * 短文本整段解析更快，只有长文本才需要避免每帧全量重解析。
 */
export const MARKDOWN_BLOCK_THRESHOLD = 8_000;
