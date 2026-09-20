/**
 * Codex 的协议解析
 *
 * Codex 的 JSON 事件流（codex exec --json，每行一个 JSON 对象）。
 * 顶层事件（官方 @openai/codex-sdk 的 ThreadEvent）：
 *   {"type":"thread.started","thread_id":"..."}                       会话开始（含会话 id）
 *   {"type":"turn.started"}                                          本轮开始
 *   {"type":"item.started"|"item.completed","item":{...}}            条目状态推进
 *   {"type":"turn.completed","usage":{...}}                          本轮结束
 *   {"type":"turn.failed","error":{"message":"..."}}                 本轮失败
 *   {"type":"error","message":"..."}                                 流级不可恢复错误
 *
 * 官方对 turn 的定义是「处理该 prompt 期间发生的全部事件」，
 * 因此一次 codex exec 只会有一次 turn.completed。
 *
 * item 的形态（官方 ThreadItem 联合类型，只列我们关心的）：
 *   {"type":"agent_message","id":"item_1","text":"..."}              助手正文（完整文本）
 *   {"type":"reasoning","id":...,"text":"..."}                        思考摘要（完整文本）
 *   {"type":"command_execution","id":...,"command":"...",
 *    "aggregated_output":"...","exit_code":0,"status":"completed"}    shell 执行
 *   {"type":"file_change","id":...,"status":"completed",
 *    "changes":[{"path":"...","kind":"add"}]}                        补丁（只发终态）
 *   {"type":"mcp_tool_call","id":...,"tool":"...","arguments":{...},
 *    "result":{...},"error":{...},"status":"..."}                     MCP 工具调用
 *   {"type":"web_search","id":...,"query":"..."}                     联网检索
 *   {"type":"todo_list","id":...,"items":[{"text","completed"}]}     计划清单
 *   {"type":"error","id":...,"message":"..."}                        条目级「非致命」错误
 *
 * 解码策略（本文件自己的决定）：
 * - agent_message / reasoning 是**完整文本**（不是增量），发射 text / thinking 事件，
 *   由事件模型按「完整块 → 追加新块」处理；一轮里多条消息都能保留
 * - 工具类条目（file_change / mcp_tool_call / web_search）收敛成「调用 + 结果」，
 *   按 item.id 去重：首次上报发 tool_call，进入终态再补 tool_result。
 *   官方 schema 里这些条目都带 status（in_progress → completed / failed），
 *   file_change 更是只发终态——若只发调用不发结果，界面上那一行会永远停在「进行中」
 * - 错误分两级（官方定义）：顶层 error 是流级不可恢复错误 → error 事件；
 *   条目级 error 是 non-fatal「条目」→ warning 事件，不能当致命错误弹红
 * - command_execution 属于 shell 执行类，按约定不进入消息流（与 pi / opencode 一致）；
 *   它的命令与输出仍在 Codex 自己的 rollout 记录里
 * - todo_list 不映射：宿主没有「计划清单」这类事件，硬塞会污染对话；计划的价值
 *   由随后的 agent_message 正文承担。item.updated 同理不参与解码（被展示的条目
 *   都只以终态出现，command_execution 的进度更新本来就整条丢弃）
 * - turn.completed → done，让 UI 及时收起流式指示器
 *
 * 条目类型 → 展示（kind / target）的映射由本文件直接给出：Codex 的事件里没有
 * 统一的「工具名」概念，只有条目类型，这属于本 provider 的协议知识。
 */

import type { AgentEvent } from "../../../shared/types";
import { describeTool } from "../tool-display";

interface CodexChange {
  path?: string;
  kind?: string;
}

interface CodexItem {
  id?: string;
  type?: string;
  /** agent_message / reasoning */
  text?: string;
  /** 条目级 error */
  message?: string;
  /** web_search */
  query?: string;
  /** mcp_tool_call */
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown; structured_content?: unknown } | null;
  error?: { message?: unknown } | null;
  /** file_change */
  changes?: CodexChange[];
  /** 工具类条目：in_progress → completed / failed；缺省视为已终态 */
  status?: string;
}

/** 工具调用事件（收敛时既要发调用也要发结果，这里收窄类型便于复用） */
type ToolCallEvent = Extract<AgentEvent, { type: "tool_call" }>;

/** 已上报的调用：open=调用已发出、在等结果；done=已收口（重复上报直接忽略） */
type CallState = "open" | "done";

/**
 * 一次运行一个解码器：记住本次运行内各次工具调用的状态，
 * 让同一条目的「进行中 → 完成」收敛成一条（调用 + 结果），而不是两行。
 * 状态是**每次运行**新建的（provider 在 start() 里调用本函数）。
 */
export function createDecoder(): (line: string) => AgentEvent | AgentEvent[] | null {
  const calls = new Map<string, CallState>();
  return (line) => decode(line, calls);
}

/** 从 thread.started 行提取会话 id（thread_id，可直接用于 exec resume） */
export function extractSessionId(line: string): string | null {
  try {
    const obj = JSON.parse(line) as { type?: string; thread_id?: unknown };
    if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
      return obj.thread_id;
    }
    return null;
  } catch {
    return null;
  }
}

/** 把一行 JSON 解码为事件 */
export function decode(
  line: string,
  calls: Map<string, CallState>,
): AgentEvent | AgentEvent[] | null {
  if (!line.trim()) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // 非 JSON 行，忽略
  }

  switch (obj.type) {
    case "item.started":
    case "item.completed": {
      const item = obj.item as CodexItem | undefined;
      return item ? decodeItem(item, calls) : null;
    }

    case "turn.completed":
      return { type: "done" };

    case "turn.failed": {
      const error = obj.error as { message?: unknown } | undefined;
      const message = typeof error?.message === "string" ? error.message : "Codex 运行失败";
      return { type: "error", message };
    }

    // 顶层 error：官方定义是「流级不可恢复错误」，必须让用户看到失败原因
    case "error": {
      const message = typeof obj.message === "string" ? obj.message : "Codex 运行失败";
      return { type: "error", message };
    }

    // thread.started / turn.started 等生命周期事件：无内容可展示
    default:
      return null;
  }
}

/** 单个条目的解码 */
function decodeItem(item: CodexItem, calls: Map<string, CallState>): AgentEvent | AgentEvent[] | null {
  const id = item.id ?? "";
  // 条目是否已进入终态（官方 schema 里用 status 推进）
  const isTerminal = item.status !== "in_progress";

  switch (item.type) {
    case "agent_message":
      // 只有完成阶段才带完整正文；没有正文的上报不发事件
      return item.text ? { type: "text", content: item.text } : null;

    case "reasoning":
      return item.text ? { type: "thinking", content: item.text } : null;

    case "error":
      // 官方定义：条目级 error 是 non-fatal（例如 "command output truncated"），
      // 红色致命错误只留给顶层 error / turn.failed
      return { type: "warning", message: item.message || "Codex 警告" };

    case "file_change": {
      // 官方：补丁只发一次，且已带终态 status（completed / failed）
      const changes = item.changes ?? [];
      const call: ToolCallEvent = {
        type: "tool_call",
        name: "file_change",
        input: changes,
        kind: "write",
        target: changes.find((c) => c.path)?.path ?? "",
      };
      return emit(
        convergeCall(calls, id, call, {
          output: changes.map((c) => `${c.path ?? ""} (${c.kind ?? "update"})`).join("\n"),
          isError: item.status === "failed",
        }),
      );
    }

    case "mcp_tool_call": {
      const name = item.tool ?? "";
      const display = describeTool(name, item.arguments);
      // 与 bash 同名的 MCP 工具沿用「静默」约定
      if (!display) return null;
      const call: ToolCallEvent = {
        type: "tool_call",
        name,
        input: item.arguments ?? {},
        kind: display.kind,
        target: display.target,
      };
      return emit(
        convergeCall(
          calls,
          id,
          call,
          isTerminal ? { output: mcpOutput(item), isError: item.status === "failed" } : null,
        ),
      );
    }

    case "web_search": {
      // 官方只在 item.completed 发这一条，且没有结果正文：直接按「已完成」收口
      const query = item.query ?? "";
      const call: ToolCallEvent = {
        type: "tool_call",
        name: "web_search",
        input: { query },
        kind: "search",
        target: query,
      };
      return emit(convergeCall(calls, id, call, { output: "", isError: false }));
    }

    // shell 执行类：按约定不进消息流
    case "command_execution":
      return null;

    // todo_list 等：宿主没有对应的事件模型（见文件头说明）
    default:
      return null;
  }
}

/** 收敛结果为事件；空数组表示无可上报内容 */
function emit(events: AgentEvent[]): AgentEvent | AgentEvent[] | null {
  return events.length > 0 ? events : null;
}

/**
 * 工具类条目的收敛。
 * 官方 schema 里 tool 类条目的 status 会从 in_progress 推进到 completed / failed，
 * 同一条目会因此上报多次：首次见到只发调用，进入终态才补结果，
 * 这样 UI 上「进行中 → 完成 / 失败」落在同一行，而不是两行。
 */
function convergeCall(
  calls: Map<string, CallState>,
  id: string,
  call: ToolCallEvent,
  result: { output: string; isError: boolean } | null,
): AgentEvent[] {
  if (calls.get(id) === "done") return []; // 已收口：重复上报直接忽略

  const events: AgentEvent[] = [];
  if (calls.get(id) !== "open") {
    calls.set(id, "open");
    events.push(call);
  }
  if (result) {
    calls.set(id, "done");
    events.push({
      type: "tool_result",
      name: call.name,
      output: result.output,
      isError: result.isError,
    });
  }
  return events;
}

/** MCP 调用的结果文本：优先错误信息，其次内容块文本，最后结构化内容 */
function mcpOutput(item: CodexItem): string {
  if (typeof item.error?.message === "string") return item.error.message;

  const result = item.result;
  if (!result) return "";

  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block && typeof block === "object") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  if (parts.length > 0) return parts.join("");

  return result.structured_content != null
    ? JSON.stringify(result.structured_content, null, 2)
    : "";
}
