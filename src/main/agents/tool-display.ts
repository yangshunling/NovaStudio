/**
 * 工具调用的展示归一化 —— provider 侧可选复用的基础设施
 *
 * 「某个工具的调用该怎么呈现」是**协议知识**：工具叫什么、操作对象藏在 input 的
 * 哪个字段、哪些调用的输出噪声过大不值得进消息流 —— 这些只有最了解该 CLI 的
 * 那一层才知道。所以归一化收在 provider 侧，宿主只消费 `kind` / `target`。
 *
 * 与 line-run.ts 同样属于「可选复用」：工具的命名或参数形状与这里对不上的
 * provider，自己写一个等价的 describeTool 即可，不必套用本文件。
 */

import type { ToolKind } from "../../shared/types";

export interface ToolDisplay {
  /** 展示分类，宿主据此选图标与配色 */
  kind: ToolKind;
  /** 操作对象原文（路径 / 命令 / 模式串）；是否缩短交给展示层 */
  target: string;
}

/** 工具名 → 分类。未列出的名字归为 other */
const KIND_BY_NAME: Record<string, ToolKind> = {
  read: "read",
  view: "read",
  write: "write",
  edit: "write",
  patch: "write",
  multiedit: "write",
  grep: "search",
  glob: "search",
  search: "search",
  bash: "exec",
  shell: "exec",
  sh: "exec",
};

/**
 * 不进消息流的工具名。
 *
 * shell 执行类：CLI 会把命令的完整输出回吐，逐条展示会淹没正文，
 * 因此约定不展示。
 * 按名字而非分类匹配 —— 避免把未来某个叫法不同的 exec 类工具一并静默掉。
 */
const SILENT_TOOLS: ReadonlySet<string> = new Set(["bash", "shell", "sh"]);

/** 操作对象候选字段，按优先级排列 */
const TARGET_KEYS = [
  "path",
  "file",
  "filePath",
  "file_path",
  "command",
  "pattern",
  "query",
] as const;

/**
 * 归一化一次工具调用。
 * 返回 null 表示该调用按约定不进入消息流（调用方直接不发射事件）。
 */
export function describeTool(name: string, input: unknown): ToolDisplay | null {
  if (isSilentTool(name)) return null;
  return { kind: KIND_BY_NAME[name.toLowerCase()] ?? "other", target: rawTarget(input) };
}

/** 该工具是否按约定不进消息流（同时适用于它的 tool_result） */
export function isSilentTool(name: string): boolean {
  return SILENT_TOOLS.has(name.toLowerCase());
}

/** 从 input 里取出操作对象原文；取不到则返回空串 */
function rawTarget(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const field of TARGET_KEYS) {
    const value = record[field];
    if (typeof value === "string" && value) return value;
  }
  return "";
}
