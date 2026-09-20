/**
 * Pi 的协议解析
 *
 * Pi 的 JSON 事件流（pi --mode json，每行一个 JSON 对象）：
 *   {"type":"session","id":"...","cwd":"..."}                 会话开始（含 session id）
 *   {"type":"agent_start" / "turn_start"}                     生命周期标记
 *   {"type":"message_update","assistantMessageEvent":{...}}   内容事件
 *     ├─ thinking_start / thinking_delta / thinking_end (content)
 *     ├─ text_start / text_delta / text_end (content)
 *     └─ toolcall_start / toolcall_delta / toolcall_end (toolCall.{name,arguments})
 *   {"type":"tool_execution_end","toolName":"...","result":{"content":[{text}]}}
 *   {"type":"message_end","message":{...}}                    本轮的权威消息
 *   {"type":"agent_end"}                                      结束
 *
 * 解码策略（本文件自己的决定，不依赖任何共享管线）：
 * - delta 事件实时输出（thinking_delta / text_delta）→ 打字机流式
 * - message_end / agent_end 输出整轮权威块 → 由事件模型的收敛规则替换累积块
 *   （收敛规则见 shared/merge.ts，属于事件语义，与本文件无关）
 * - 工具调用先经 tool-display 归一为 kind / target；按约定不展示的工具
 *   （shell 执行类）在这里就被丢掉，不进入消息流
 */

import type { AgentEvent } from "../../../shared/types";
import { describeTool, isSilentTool } from "../tool-display";

/** 从 content 提取文本（content 可能是 string 或 TextContent[]） */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

/**
 * 把 message.content 映射为权威块（pi 已内部去重）。
 *
 * 块形状以 pi 自己的消息为准（与它写进会话 JSONL 的完全一致）：
 *   {type:"text",text} / {type:"thinking",thinking} / {type:"toolCall",name,arguments}
 * 注意工具块是 camelCase 的 `toolCall` + `arguments` —— 不是 Anthropic 风格的
 * `tool_use` + `input`；写错会让工具调用在权威块里整体消失。
 */
export function mapMessageContent(content: unknown): AgentEvent[] {
  if (!Array.isArray(content)) return [];
  const out: AgentEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "thinking" && typeof b.thinking === "string") {
      out.push({ type: "thinking", content: b.thinking });
    } else if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", content: b.text });
    } else if (b.type === "toolCall" && typeof b.name === "string") {
      const display = describeTool(b.name, b.arguments);
      if (display) {
        out.push({
          type: "tool_call",
          name: b.name,
          input: b.arguments ?? {},
          kind: display.kind,
          target: display.target,
        });
      }
    }
    // redacted_thinking / image 等其它块忽略
  }
  return out;
}

/** 从 tool_execution_end.result 提取文本输出与错误标记 */
function extractToolOutput(result: unknown): { output: string; isError: boolean } {
  if (!result) return { output: "", isError: false };
  if (typeof result === "string") return { output: result, isError: false };
  const r = result as { content?: unknown; isError?: boolean };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const c of r.content) {
      if (c && typeof c === "object" && "text" in c) {
        const text = (c as { text: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return { output: parts.join(""), isError: !!r.isError };
}

/** 从一行输出中提取会话 id（pi 在会话开始时输出 {"type":"session","id":"..."}） */
export function extractSessionId(line: string): string | null {
  try {
    const obj = JSON.parse(line) as { type?: string; id?: unknown };
    if (obj.type === "session" && typeof obj.id === "string") return obj.id;
    return null;
  } catch {
    return null;
  }
}

/** 把一行 JSON 解码为事件 */
export function decode(line: string): AgentEvent | AgentEvent[] | null {
  if (!line.trim()) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // 非 JSON 行，忽略
  }

  const type = obj.type;

  // === 顶层事件 ===
  if (type === "agent_end") {
    // 本轮运行结束。messages 是本轮**全部**消息（可能横跨多个 turn），
    // 不能当成「权威块」整段替换末尾 —— 那会把已经流过的思考 / 正文 / 工具调用
    // 再追加一份，界面上直接变成两份。
    // 每条消息的权威快照由它自己的 message_end 给出（见下），这里只需标记结束；
    // 收尾由进程退出后的 agent:done 完成，故不发射任何事件。
    return null;
  }

  if (type === "message_end") {
    // 权威最终消息：pi 已内部去重。即使 delta 被重复发送，
    // 以此为准替换累积块，最终收敛到单份正确内容。
    const msg = obj.message as { role?: string; content?: unknown } | undefined;
    if (msg && msg.role === "assistant") {
      const blocks = mapMessageContent(msg.content);
      if (blocks.length > 0) return { type: "message_end", blocks };
    }
    return null;
  }

  if (type === "tool_execution_end") {
    const name = (obj.toolName as string) ?? "";
    if (isSilentTool(name)) return null;
    const { output, isError } = extractToolOutput(obj.result);
    return { type: "tool_result", name, output, isError };
  }

  // === 内容事件嵌套在 message_update.assistantMessageEvent 中 ===
  const event = obj.assistantMessageEvent as
    | {
        type?: string;
        delta?: string;
        toolCall?: { name?: string; arguments?: unknown };
      }
    | undefined;
  if (!event || typeof event.type !== "string") return null;

  switch (event.type) {
    case "thinking_delta":
      return { type: "thinking_delta", delta: event.delta ?? "" };

    case "text_delta":
      return { type: "text_delta", delta: event.delta ?? "" };

    // thinking_end / text_end 不发射整块：pi 的 *_end 到达顺序与块顺序不一致
    // （思考的 end 可能晚于正文 start），若发射会与 delta 累积块重复。
    // 内容已由 delta 累积、最终由 message_end 提供权威块，*_end 是冗余信号。
    case "thinking_end":
    case "text_end":
      return null;

    // 工具调用结束（取完整 toolCall；工具无 delta 合并，需要此事件）
    case "toolcall_end": {
      const name = event.toolCall?.name ?? "unknown";
      const input = event.toolCall?.arguments ?? {};
      const display = describeTool(name, input);
      if (!display) return null;
      return { type: "tool_call", name, input, kind: display.kind, target: display.target };
    }

    // 其余 start / end 忽略
    default:
      return null;
  }
}
