/**
 * OpenCode 的协议解析
 *
 * OpenCode 的 JSON 事件流（--format json，每行一个 JSON 对象）：
 *   {"type":"step_start","timestamp":...,"sessionID":"ses_...","part":{"type":"step-start",...}}
 *   {"type":"text","timestamp":...,"sessionID":"ses_...","part":{"type":"text","text":"...",...}}
 *   {"type":"reasoning","timestamp":...,"sessionID":"ses_...","part":{"type":"reasoning","text":"..."}}
 *   {"type":"tool","timestamp":...,"sessionID":"ses_...","part":{"type":"tool","tool":"read",
 *      "callID":"...","state":{"status":"completed","input":{...},"output":"..."}}}
 *   {"type":"step_finish","timestamp":...,"sessionID":"ses_...","part":{"type":"step-finish",...}}
 *
 * 解码策略（本文件自己的决定）：
 * - text / reasoning 是**完整块**（不是增量），因此发射 text / thinking 事件，
 *   由事件模型的收敛规则按"完整块 → 追加新块"处理，多个块都能保留。
 * - 工具事件在 status 为 completed 时同时带 input 与 output，
 *   发射 [tool_call, tool_result] 两个事件，保证 UI 能配对显示调用与结果。
 * - 但 tool part 会**随状态推进在流里重复出现**（先 running 带 input，后 completed
 *   带 input + output）。若不认人，同一次调用会被发成两条，UI 上就会出现
 *   「read 进行中」与「read 完成」两行。因此解码器带一份**本次运行内**的调用状态：
 *   已上报过的调用在完成时只补 tool_result，把状态更新到原来那一行上。
 * - 工具名到展示分类（kind / target）的归一化交给 tool-display，
 *   按约定不展示的工具（shell 执行类）在这里就被丢掉，不进入消息流。
 */

import type { AgentEvent, Message } from "../../../shared/types";
import { describeTool } from "../tool-display";

interface OpenCodePart {
  type?: string;
  text?: string;
  tool?: string;
  /** 同一次调用的稳定标识（opencode 的 tool part 自带） */
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
  };
}

interface OpenCodeMessageRecord {
  info?: { id?: string; role?: string; time?: { created?: number } };
  parts?: OpenCodePart[];
}

/** 把工具输出统一为字符串（对象则格式化 JSON） */
function stringifyOutput(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** 从每一行都带的 sessionID 字段提取会话 id（格式 ses_xxx，可直接复用） */
export function extractSessionId(line: string): string | null {
  try {
    const obj = JSON.parse(line) as { sessionID?: unknown };
    return typeof obj.sessionID === "string" ? obj.sessionID : null;
  } catch {
    return null;
  }
}

/**
 * 一次运行一个解码器：把「本次运行内各次工具调用处于什么状态」记在闭包里，
 * 让同一次调用的多次上报收敛成一条（调用 + 结果），而不是两条。
 *
 * 集合是**每次运行**新建的（provider 在 start() 里调用本函数），
 * 不跨轮次、不跨会话，因此不会把不同轮次的调用混为一谈。
 */
export function createDecoder(): (line: string) => AgentEvent | AgentEvent[] | null {
  const calls = new Map<string, CallState>();
  return (line) => decode(line, calls);
}

/**
 * 同一次调用的身份：优先用 callID（同一次调用的稳定标识）；
 * 协议没给时退化为「工具名 + 入参」，两次上报的入参在 JSON 上一致即认为是同一次。
 */
function callKey(part: OpenCodePart, toolName: string): string {
  const id = part.callID;
  if (id) return `id:${id}`;
  return `sig:${toolName}:${JSON.stringify(part.state?.input ?? null)}`;
}

/** 已上报的调用：open=调用已发出、在等结果；done=已收口（重复上报直接忽略） */
type CallState = "open" | "done";

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

  const part = obj.part as OpenCodePart | undefined;
  if (!part || typeof part.type !== "string") return null;

  switch (part.type) {
    case "step-start":
      return null;

    case "text":
      // 完整文本块（非增量）
      return { type: "text", content: part.text ?? "" };

    case "reasoning":
      return { type: "thinking", content: part.text ?? "" };

    case "tool": {
      const state = part.state;
      if (!state) return null;

      const toolName = part.tool ?? "unknown";
      const display = describeTool(toolName, state.input);
      // 约定不展示的工具：调用与结果一并丢弃
      if (!display) return null;

      const key = callKey(part, toolName);
      const reported = calls.get(key) === "open"; // 这条调用是否已经上报过
      if (calls.get(key) === "done") return null; // 同一次调用的重复上报，直接忽略

      const hasOutput = state.output != null;
      const output = hasOutput ? stringifyOutput(state.output) : "";
      const call: AgentEvent = {
        type: "tool_call",
        name: toolName,
        input: state.input ?? {},
        kind: display.kind,
        target: display.target,
      };

      // 工具完成：input 与 output 同时可用
      if (state.status === "completed" && hasOutput) {
        calls.set(key, "done");
        const events: AgentEvent[] = [];
        // 已经上报过调用 → 只补结果，UI 把状态更新到原来那一行；
        // 没上报过（流里首个可见状态就是 completed）→ 补发调用，保证能配对显示
        if (state.input && !reported) events.push(call);
        events.push({ type: "tool_result", name: toolName, output, isError: false });
        return events;
      }

      // 工具开始（或状态推进）：只有 input
      if (state.input) {
        calls.set(key, "open");
        return reported ? null : call;
      }

      // 错误状态
      if (state.status === "error") {
        calls.set(key, "done");
        return {
          type: "tool_result",
          name: toolName,
          output: output || String(state.output ?? ""),
          isError: true,
        };
      }

      return null;
    }

    case "step-finish":
      return { type: "done" };

    default:
      return null;
  }
}

/**
 * 把 `opencode export` 返回的 messages 结构解析为 UI 消息列表。
 * 独立的 tool 消息会追加到上一条 assistant 消息，与流式时的呈现保持一致。
 */
export function parseExportMessages(records: unknown[]): Message[] {
  const result: Message[] = [];
  let lastAssistant: Message | null = null;

  for (const raw of records) {
    const record = raw as OpenCodeMessageRecord;
    const role = record.info?.role;
    if (!role) continue;
    const timestamp = record.info?.time?.created ?? Date.now();
    const id = record.info?.id ?? "";
    const parts = record.parts ?? [];

    if (role === "user") {
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");
      result.push({
        id,
        role: "user",
        content: [{ type: "text", content: text }],
        timestamp,
      });
      lastAssistant = null;
    } else if (role === "assistant") {
      const blocks: AgentEvent[] = [];
      for (const part of parts) {
        switch (part.type) {
          case "reasoning":
            blocks.push({ type: "thinking", content: part.text ?? "" });
            break;
          case "text":
            blocks.push({ type: "text", content: part.text ?? "" });
            break;
          case "tool": {
            const state = part.state;
            const toolName = part.tool ?? "unknown";
            const display = describeTool(toolName, state?.input);
            if (!display) break; // 约定不展示的工具
            if (state?.input) {
              blocks.push({
                type: "tool_call",
                name: toolName,
                input: state.input,
                kind: display.kind,
                target: display.target,
              });
            }
            if (state?.output != null) {
              blocks.push({
                type: "tool_result",
                name: toolName,
                output: stringifyOutput(state.output),
                isError: state.status === "error",
              });
            }
            break;
          }
          // step-start / step-finish 忽略
        }
      }
      const message: Message = { id, role: "assistant", content: blocks, timestamp };
      result.push(message);
      lastAssistant = message;
    } else if (role === "tool" && lastAssistant) {
      const part = parts[0];
      const state = part?.state;
      const toolName = part?.tool ?? "tool";
      if (describeTool(toolName, state?.input) && state?.output != null) {
        lastAssistant.content.push({
          type: "tool_result",
          name: toolName,
          output: stringifyOutput(state.output),
          isError: state.status === "error",
        });
      }
    }
  }
  return result;
}
