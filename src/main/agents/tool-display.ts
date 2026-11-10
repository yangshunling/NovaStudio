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
import { TOOL_TARGET_KEYS, readStringField } from "../../shared/tool-input";

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
 * 归一化一次工具调用。
 *
 * 所有工具都进入消息流（包括 Bash 等 shell 执行类）：聊天、任务中心与
 * 工作流运行记录需要看到完整执行链路，是否折叠由展示层决定 —— 这里的
 * 职责只是给出分类与操作对象。
 */
export function describeTool(name: string, input: unknown): ToolDisplay {
  return { kind: KIND_BY_NAME[name.toLowerCase()] ?? "other", target: rawTarget(input) };
}

/** 从 input 里取出操作对象原文；取不到则返回空串 */
function rawTarget(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  return readStringField(
    input as Record<string, unknown>,
    TOOL_TARGET_KEYS,
  );
}
