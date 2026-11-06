/**
 * 工具调用的文件变更提取与行级 diff
 *
 * provider 只透传原始 input，工具名与参数形状各家的叫法并不统一：
 * 同一个「旧文本 → 新文本」的替换，Claude Code 叫 old_string/new_string，
 * 别家可能叫 old_str/new_str。所以这里按**字段语义**识别（一组候选别名），
 * 而不是硬编码某个 CLI 的工具名。
 *
 * 展示层只消费 FileChange：路径、逐行 diff、增删计数。
 */

import type { ToolKind } from "@shared/types";

export interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
  /** 旧文件行号；新增行为 null */
  oldLine: number | null;
  /** 新文件行号；删除行为 null */
  newLine: number | null;
}

export interface FileChange {
  path: string;
  /** 没有旧内容（新建 / 整文件写入） */
  created: boolean;
  added: number;
  removed: number;
  /**
   * 是否知道这些变更在文件中的真实行号。
   * 为 false 时展示层不画行号 —— 与其从 1 开始编造，不如不显示。
   */
  numbered: boolean;
  /** 已按展示上限裁剪 */
  lines: DiffLine[];
  /** 因超出展示上限而未渲染的行数 */
  hiddenLines: number;
}

/** 工具名兜底识别：即便 kind 没能归到 write，也认得出这些语义 */
const WRITE_TOOL_NAME =
  /^(write|create|save|edit|multiedit|notebookedit|patch|apply_patch|replace|insert|str_replace\w*|file_write|write_file)$/i;

/** 操作对象路径候选字段 */
const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
  "filename",
  "file",
] as const;

/** 旧文本候选字段 */
const OLD_KEYS = [
  "old_string",
  "oldString",
  "old_str",
  "oldText",
  "old_text",
  "old_content",
  "oldContent",
  "original",
  "before",
  "search",
] as const;

/** 新文本候选字段 */
const NEW_KEYS = [
  "new_string",
  "newString",
  "new_str",
  "newText",
  "new_text",
  "new_content",
  "newContent",
  "new_source",
  "newSource",
  "content",
  "file_text",
  "replacement",
  "after",
  "replace",
] as const;

/** DP diff 的规模上限：超过就走「整段替换」的粗粒度结果，避免卡住渲染线程 */
const MAX_DP_CELLS = 250_000;

/** 单个文件最多渲染的 diff 行数（超出折叠提示） */
const MAX_RENDER_LINES = 400;

// ============================================================================
// 提取
// ============================================================================

/**
 * 从工具调用中提取文件变更。
 * 不是「改文件」的调用（read / bash / grep…）返回空数组。
 */
export function extractFileChanges(
  toolName: string,
  input: unknown,
  kind: ToolKind,
  lineStarts?: number[],
): FileChange[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const path = readString(record, PATH_KEYS) ?? "";
  const looksLikeWrite = kind === "write" || WRITE_TOOL_NAME.test(toolName);

  // MultiEdit / 多段替换：edits 数组里每一项都是一次替换
  const edits = record.edits;
  if (Array.isArray(edits)) {
    const changes: FileChange[] = [];
    for (let i = 0; i < edits.length; i += 1) {
      const edit = edits[i];
      if (!edit || typeof edit !== "object") continue;
      const item = edit as Record<string, unknown>;
      const oldText = readString(item, OLD_KEYS);
      const newText = readString(item, NEW_KEYS);
      if (oldText === null || newText === null) continue;
      const change = buildFileChange(path, oldText, newText, false, lineStarts?.[i]);
      if (change.added + change.removed > 0) changes.push(change);
    }
    if (changes.length > 0) return changes;
  }

  const oldText = readString(record, OLD_KEYS);
  const newText = readString(record, NEW_KEYS);

  // 替换：新旧都有
  if (oldText !== null && newText !== null) {
    const change = buildFileChange(path, oldText, newText, false, lineStarts?.[0]);
    // 新旧完全一致：不产生任何 diff 行，按「没有变更」处理
    return change.added + change.removed > 0 ? [change] : [];
  }

  // 整文件写入：只有新内容。只有确认这是写文件的工具才展示，
  // 否则别的工具里叫 content 的字段会被误当成变更。
  if (newText !== null && looksLikeWrite) {
    // 整文件写入从第 1 行开始，行号是确定的
    return [buildFileChange(path, "", newText, true, 1)];
  }

  return [];
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

// ============================================================================
// diff
// ============================================================================

export function buildFileChange(
  path: string,
  oldText: string,
  newText: string,
  created: boolean,
  /** 变更在文件中的起始行号（1-based）；缺省表示位置未知 */
  startLine?: number,
): FileChange {
  const raw = diffLines(splitLines(oldText), splitLines(newText));
  const numbered = typeof startLine === "number" && startLine > 0;
  let oldNo = numbered ? startLine! - 1 : 0;
  let newNo = numbered ? startLine! - 1 : 0;
  let added = 0;
  let removed = 0;

  const all: DiffLine[] = raw.map((line) => {
    if (line.type === "add") {
      newNo += 1;
      added += 1;
      return { ...line, oldLine: null, newLine: newNo };
    }
    if (line.type === "del") {
      oldNo += 1;
      removed += 1;
      return { ...line, oldLine: oldNo, newLine: null };
    }
    oldNo += 1;
    newNo += 1;
    return { ...line, oldLine: oldNo, newLine: newNo };
  });

  return {
    path,
    created,
    added,
    removed,
    numbered,
    lines: all.slice(0, MAX_RENDER_LINES),
    hiddenLines: Math.max(0, all.length - MAX_RENDER_LINES),
  };
}

interface RawLine {
  type: DiffLine["type"];
  text: string;
}

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  // 末尾换行不代表多一行空行
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 行级 diff：先剥离公共前后缀缩小规模，中间段用 LCS 动态规划。
 * 中间段过大时退化为「整段删除 + 整段新增」——结果依然正确，只是不够精细。
 */
function diffLines(a: string[], b: string[]): RawLine[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const out: RawLine[] = [];
  for (let i = 0; i < start; i += 1) out.push({ type: "ctx", text: a[i] });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length <= MAX_DP_CELLS) {
    out.push(...lcsDiff(midA, midB));
  } else {
    for (const text of midA) out.push({ type: "del", text });
    for (const text of midB) out.push({ type: "add", text });
  }

  for (let i = endA; i < a.length; i += 1) out.push({ type: "ctx", text: a[i] });
  return out;
}

function lcsDiff(a: string[], b: string[]): RawLine[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ type: "add" as const, text }));
  if (m === 0) return a.map((text) => ({ type: "del" as const, text }));

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const out: RawLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ type: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i] });
    i += 1;
  }
  while (j < m) {
    out.push({ type: "add", text: b[j] });
    j += 1;
  }
  return out;
}
