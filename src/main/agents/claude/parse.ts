/**
 * Claude Code 的协议解析
 *
 * Claude Code 的 JSON 事件流（-p --output-format stream-json --verbose，
 * 加上 --include-partial-messages 后才有增量），每行一个 JSON 对象：
 *   {"type":"system","subtype":"init","session_id":"...","tools":[...]}
 *   {"type":"stream_event","event":{"type":"content_block_delta",
 *      "delta":{"type":"text_delta","text":"..."}},"session_id":"..."}
 *   {"type":"assistant","message":{"role":"assistant","content":[
 *      {"type":"text","text":"..."} |
 *      {"type":"thinking","thinking":"..."} |
 *      {"type":"tool_use","id":"toolu_...","name":"Read","input":{...}}
 *    ]},"session_id":"...","parent_tool_use_id":null}
 *   {"type":"user","message":{"role":"user","content":[
 *      {"type":"tool_result","tool_use_id":"toolu_...","content":"...","is_error":false}
 *    ]},"session_id":"..."}
 *   {"type":"result","subtype":"success","session_id":"...","result":"..."}
 *
 * 解码策略（本文件自己的决定）：
 * - 增量（content_block_delta）实时发射 text_delta / thinking_delta → 打字机流式
 * - assistant 事件是**按 content block 逐条发的**：一个 text 块、一个 tool_use 块
 *   就是两条 assistant，每条只带自己那一个块（官方 Message flow 明确如此）。
 *   因此解码器按 assistant 消息归组（message.id，并以 stream_event 的 message_start
 *   作为换消息的信号），每收到一块就用「该消息已累积的全集」发 message_end，
 *   由事件模型的收敛规则替换累积块。
 *   若把单块直接当「本轮权威块」发出去，收敛规则会连同同一条消息里前面已经完成
 *   的块一起删掉 —— 思考与正文会被随后的块吃掉，这是必须避开的坑。
 * - tool_use 与 tool_result 靠 id 配对：tool_result 协议里只有 tool_use_id、
 *   没有工具名，因此解码器记住本次运行内 id → 工具名，给结果补上宿主需要的 name
 * - 工具名到展示分类的归一化交给 tool-display；按约定不展示的工具（Bash 等
 *   shell 执行类）在调用与结果两侧都被丢掉，不进入消息流
 */

import type { AgentEvent } from "../../../shared/types";
import { describeTool, isSilentTool } from "../tool-display";

/** Anthropic 风格的内容块（只声明我们关心的字段） */
interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  /** tool_use 块 */
  id?: string;
  name?: string;
  input?: unknown;
  /** tool_result 块 */
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** 本次运行内 tool_use id → 工具名，用于给不带工具名的 tool_result 补 name */
export type CallNames = Map<string, string>;

/** 从每一行都带的 session_id 字段提取会话 id（uuid，可直接用于 --resume） */
export function extractSessionId(line: string): string | null {
  try {
    const obj = JSON.parse(line) as { session_id?: unknown };
    return typeof obj.session_id === "string" ? obj.session_id : null;
  } catch {
    return null;
  }
}

/**
 * tool_result 的内容可能是字符串，也可能是 [{type:"text",text}]。
 * 统一取文本；取不到则返回空串。
 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

/**
 * assistant 消息的 content → 事件块。
 * 同时记录 tool_use 的 id → 工具名，供随后到达的 tool_result 使用。
 */
export function mapAssistantBlocks(content: unknown, names: CallNames): AgentEvent[] {
  if (!Array.isArray(content)) return [];
  const out: AgentEvent[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as ContentBlock;

    if (block.type === "thinking" && typeof block.thinking === "string") {
      if (block.thinking) out.push({ type: "thinking", content: block.thinking });
    } else if (block.type === "text" && typeof block.text === "string") {
      if (block.text) out.push({ type: "text", content: block.text });
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      if (block.id) names.set(block.id, block.name);
      const display = describeTool(block.name, block.input);
      // 约定不展示的工具：调用不进消息流（名字已记录，其结果同样会被丢掉）
      if (!display) continue;
      out.push({
        type: "tool_call",
        callId: block.id,
        name: block.name,
        input: block.input ?? {},
        kind: display.kind,
        target: display.target,
      });
    }
    // redacted_thinking / image 等其它块忽略
  }
  return out;
}

/** user 消息里的 tool_result 块 → 事件；按 call id 补上工具名 */
export function mapToolResultBlocks(content: unknown, names: CallNames): AgentEvent[] {
  if (!Array.isArray(content)) return [];
  const out: AgentEvent[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as ContentBlock;
    if (block.type !== "tool_result") continue;
    const name = (block.tool_use_id && names.get(block.tool_use_id)) || "tool";
    if (isSilentTool(name)) continue;
    out.push({
      type: "tool_result",
      callId: block.tool_use_id,
      name,
      output: resultText(block.content),
      isError: !!block.is_error,
    });
  }
  return out;
}

/**
 * 当前 assistant 消息的累积状态。
 * Claude 的 assistant 事件按 content block 逐条到达、每条只带一个块，
 * 所以要按消息归组：message_start 开一条新消息，随后每条 assistant 追加自己的块。
 */
export interface MessageBuffer {
  /** 本条 assistant 消息的 message.id（同一消息的各块共用它） */
  id: string | null;
  /** 本条消息已收到的全部块（不展示的工具已剔除） */
  blocks: AgentEvent[];
}

/**
 * 一次运行一个解码器：把「本次运行内各次工具调用叫什么」与「当前 assistant 消息
 * 已累积了哪些块」记在闭包里。前者让 tool_result 能补上工具名（协议只给 id），
 * 后者让按块到达的 assistant 事件能拼成完整消息再发权威块。
 */
export function createDecoder(): (line: string) => AgentEvent | AgentEvent[] | null {
  const names: CallNames = new Map();
  const buffer: MessageBuffer = { id: null, blocks: [] };
  return (line) => decode(line, names, buffer);
}

/** 把一行 JSON 解码为事件 */
export function decode(
  line: string,
  names: CallNames,
  buffer: MessageBuffer,
): AgentEvent | AgentEvent[] | null {
  if (!line.trim()) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // 非 JSON 行（如 claude 自己打印的告警），忽略
  }

  // 子代理的对话（parent_tool_use_id 非空）不进入主对话视图
  if (obj.parent_tool_use_id != null) return null;

  const type = obj.type;

  // 增量：打字机流式的来源
  if (type === "stream_event") {
    const event = obj.event as
      | { type?: string; delta?: { type?: string; text?: string; thinking?: string } }
      | undefined;
    if (!event) return null;
    // 新消息开始：累积状态归零，随后的 assistant 属于这条新消息
    if (event.type === "message_start") {
      buffer.id = null;
      buffer.blocks = [];
      return null;
    }
    if (event.type !== "content_block_delta" || !event.delta) return null;
    const delta = event.delta;
    if (delta.type === "text_delta") return { type: "text_delta", delta: delta.text ?? "" };
    if (delta.type === "thinking_delta") {
      return { type: "thinking_delta", delta: delta.thinking ?? "" };
    }
    return null;
  }

  // 权威消息：一条 assistant 只带一个 content block，先并入本条消息的累积块，
  // 再以「累积全集」发 message_end —— 收敛规则会把末尾累积块整段换成这一份，
  // 于是 delta 与完整块不会重复，同一条消息里先到的块也不会被后到的块删掉
  if (type === "assistant") {
    const message = obj.message as { id?: unknown; content?: unknown } | undefined;
    const messageId = typeof message?.id === "string" ? message.id : null;
    // 兜底：万一没收到 message_start，靠 message.id 变化识别新消息
    if (messageId && buffer.id && messageId !== buffer.id) buffer.blocks = [];
    if (messageId) buffer.id = messageId;
    const blocks = mapAssistantBlocks(message?.content, names);
    // 只剩不展示的工具（Bash 等）：不发事件，也不并入累积块
    if (blocks.length === 0) return null;
    buffer.blocks.push(...blocks);
    return { type: "message_end", blocks: [...buffer.blocks] };
  }

  // 工具回执
  if (type === "user") {
    const message = obj.message as { content?: unknown } | undefined;
    const events = mapToolResultBlocks(message?.content, names);
    return events.length > 0 ? events : null;
  }

  // system / result 等：无内容可展示
  return null;
}
