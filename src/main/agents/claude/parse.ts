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
 *   但展示出来的工具回执是一次执行边界：并行工具调用时，回执可能夹在同一
 *   消息的后续块之前到达，此时收敛无法跨越回执替换，必须主动清空累积
 *   （见 decode 的 user 分支）。
 * - tool_use 与 tool_result 靠 id 配对：tool_result 协议里只有 tool_use_id、
 *   没有工具名，因此解码器记住本次运行内 id → 工具名，给结果补上宿主需要的 name
 * - 工具名到展示分类的归一化交给 tool-display；所有工具（含 Bash 等 shell
 *   执行类）都进入消息流，聊天 / 任务中心 / 工作流看到的是同一条链路
 */

import type { AgentEvent, ToolResultImage } from "../../../shared/types";
import { describeTool } from "../tool-display";

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
 * tool_result 里的 image 块 → 可渲染的 base64 图片。
 * 文本仍由 resultText 提取；图片单独携带，避免把 base64 塞进正文。
 */
function resultImages(content: unknown): ToolResultImage[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const images: ToolResultImage[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: unknown; source?: unknown };
    if (record.type !== "image" || !record.source || typeof record.source !== "object") {
      continue;
    }
    const source = record.source as {
      type?: unknown;
      media_type?: unknown;
      data?: unknown;
    };
    if (source.type !== "base64" || typeof source.data !== "string" || !source.data) {
      continue;
    }
    images.push({
      mediaType:
        typeof source.media_type === "string" && source.media_type
          ? source.media_type
          : "image/png",
      data: source.data,
    });
  }
  return images.length > 0 ? images : undefined;
}

/** API 错误 assistant 记录的错误文案：优先取 content 里的 text 块，其次取 error 字段 */
function assistantErrorText(content: unknown, error: unknown): string {
  if (typeof content === "string") return content.trim();
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const record = block as { type?: unknown; text?: unknown };
        if (record.type === "text" && typeof record.text === "string" && record.text) {
          parts.push(record.text);
        }
      }
    }
  }
  const text = parts.join("\n").trim();
  if (text) return text;
  return typeof error === "string" && error ? `API 错误（${error}）` : "";
}

/**
 * 定位一次工具改动在文件中的起始行号（1-based）。
 * 解析层本身不碰文件系统：provider 在运行时有 cwd，注入这个回调即可。
 * 返回与 input 多段替换一一对应的数组；定位不到返回 undefined。
 */
export type LineStartsResolver = (name: string, input: unknown) => number[] | undefined;

/**
 * assistant 消息的 content → 事件块。
 * 同时记录 tool_use 的 id → 工具名，供随后到达的 tool_result 使用。
 */
export function mapAssistantBlocks(
  content: unknown,
  names: CallNames,
  resolveLineStarts?: LineStartsResolver,
): AgentEvent[] {
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
      out.push({
        type: "tool_call",
        callId: block.id,
        name: block.name,
        input: block.input ?? {},
        kind: display.kind,
        target: display.target,
        lineStarts: resolveLineStarts?.(block.name, block.input),
      });
    }
    // redacted_thinking / image 等其它块忽略
  }
  return out;
}

/** user 消息里的 tool_result 块 → 事件；按 call id 补上工具名 */
export function mapToolResultBlocks(
  content: unknown,
  names: CallNames,
): AgentEvent[] {
  if (!Array.isArray(content)) return [];
  const out: AgentEvent[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as ContentBlock;
    if (block.type !== "tool_result") continue;
    const name = (block.tool_use_id && names.get(block.tool_use_id)) || "tool";
    out.push({
      type: "tool_result",
      callId: block.tool_use_id,
      name,
      output: resultText(block.content),
      isError: !!block.is_error,
      images: resultImages(block.content),
    });
  }
  return out;
}

/**
 * system 记录里值得展示的错误 / 提示。
 *
 * - api_error：API 请求失败（401/502 等），必须显示成错误
 * - informational：CLI 的非致命提示（如流式中断后重试），按 level 映射
 *
 * 其余子类型（turn_duration / compact_boundary / local_command / away_summary）
 * 属于元数据或后续功能，这里返回 null。
 */
export function mapSystemRecord(obj: {
  type?: unknown;
  subtype?: unknown;
  content?: unknown;
  level?: unknown;
  error?: unknown;
}): AgentEvent | null {
  if (obj.type !== "system") return null;
  const subtype = typeof obj.subtype === "string" ? obj.subtype : "";

  if (subtype === "api_error") {
    const error = obj.error;
    const message =
      error &&
      typeof error === "object" &&
      typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : typeof obj.content === "string" && obj.content.trim()
          ? obj.content.trim()
          : "API 请求失败";
    return { type: "error", message };
  }

  if (subtype === "informational") {
    if (typeof obj.content !== "string" || !obj.content.trim()) return null;
    return obj.level === "error"
      ? { type: "error", message: obj.content.trim() }
      : { type: "warning", message: obj.content.trim() };
  }

  return null;
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

/** 一条命令行解出的会话 id + 事件；用一次 JSON.parse 同时得到两者 */
export interface DecodedStreamLine {
  sessionId: string | null;
  event: AgentEvent | AgentEvent[] | null;
}

/** 单行解码器：返回「会话 id + 事件」（流式热路径，一次 parse 出两者） */
export type StreamDecoder = (line: string) => DecodedStreamLine | null;

/**
 * 事件版解码器（传统形态）：只返回事件。
 * 供测试与不需要 session_id 的场景使用；流式运行请用 createStreamDecoder。
 */
export function createDecoder(options?: {
  resolveLineStarts?: LineStartsResolver;
}): (line: string) => AgentEvent | AgentEvent[] | null {
  const names: CallNames = new Map();
  const buffer: MessageBuffer = { id: null, blocks: [] };
  return (line) => decode(line, names, buffer, options?.resolveLineStarts);
}

/**
 * 流式解码器：一次 JSON.parse 同时取出会话 id 与事件。
 * 行缓冲先按 extractSessionId 解析一次、再交给 decode 解析第二次，等于每行
 * 做了两次 JSON.parse；合并成一次能省掉流式热路径上一半的解析开销。
 */
export function createStreamDecoder(options?: {
  resolveLineStarts?: LineStartsResolver;
}): StreamDecoder {
  const names: CallNames = new Map();
  const buffer: MessageBuffer = { id: null, blocks: [] };
  return (line) => decodeStreamLine(line, names, buffer, options?.resolveLineStarts);
}

/**
 * 把一行 JSON 解码为「会话 id + 事件」。
 * 事件分发逻辑与 decode 共用 decodeObject，行为完全一致。
 */
export function decodeStreamLine(
  line: string,
  names: CallNames,
  buffer: MessageBuffer,
  resolveLineStarts?: LineStartsResolver,
): DecodedStreamLine | null {
  if (!line.trim()) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // 非 JSON 行（如 claude 自己打印的告警），忽略
  }

  const sessionId = typeof obj.session_id === "string" ? obj.session_id : null;
  const event = decodeObject(obj, names, buffer, resolveLineStarts);
  return { sessionId, event };
}

/** 把一行 JSON 解码为事件 */
export function decode(
  line: string,
  names: CallNames,
  buffer: MessageBuffer,
  resolveLineStarts?: LineStartsResolver,
): AgentEvent | AgentEvent[] | null {
  if (!line.trim()) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // 非 JSON 行（如 claude 自己打印的告警），忽略
  }

  return decodeObject(obj, names, buffer, resolveLineStarts);
}

/** 已 JSON.parse 的对象 → 事件（decode / decodeStreamLine 共用同一份分发逻辑） */
function decodeObject(
  obj: Record<string, unknown>,
  names: CallNames,
  buffer: MessageBuffer,
  resolveLineStarts?: LineStartsResolver,
): AgentEvent | AgentEvent[] | null {
  // 子代理的对话（parent_tool_use_id 非空）不进入主对话视图。
  // 空字符串按“主链”处理：部分网关/版本会用 "" 而不是 null 表示无父调用。
  if (obj.parent_tool_use_id != null && obj.parent_tool_use_id !== "") return null;

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

    // API 错误记录：正文是错误信息。若按普通 assistant 处理，会被当成模型
    // 正常发言展示；这里直接转成 error 事件，并清空累积块避免污染下一条消息。
    if (obj.isApiErrorMessage === true || typeof obj.error === "string") {
      buffer.id = null;
      buffer.blocks = [];
      const errorText = assistantErrorText(message?.content, obj.error);
      return errorText ? { type: "error", message: errorText } : null;
    }

    const messageId = typeof message?.id === "string" ? message.id : null;
    // 兜底：万一没收到 message_start，靠 message.id 变化识别新消息
    if (messageId && buffer.id && messageId !== buffer.id) buffer.blocks = [];
    if (messageId) buffer.id = messageId;
    const blocks = mapAssistantBlocks(message?.content, names, resolveLineStarts);
    // 没有可展示的块（例如纯 image 块）：不发事件
    if (blocks.length === 0) return null;
    buffer.blocks.push(...blocks);
    return { type: "message_end", blocks: [...buffer.blocks] };
  }

  // 工具回执
  if (type === "user") {
    const message = obj.message as { content?: unknown } | undefined;

    const events = mapToolResultBlocks(message?.content, names);

    /*
     * 展示了工具回执，就说明消息流里出现了一次执行边界，必须切断累积。
     *
     * Claude Code 在同一条 assistant 消息（message.id 不变）里逐块发
     * assistant 事件，并且并行工具调用时可能先执行完前面的工具、把
     * tool_result 写进流里，然后才发后面的 content block。若继续累积，
     * 下一个块到达时 message_end 会携带「整条消息的累积全集」；而收敛
     * 规则遇到中间夹着的 tool_result 就停住，只能整段追加 —— 于是回执
     * 之前的正文与 tool_call 被重复一遍。重复的 tool_call 还只有一份
     * result，界面上就会永久停在“进行中”。
     */
    if (events.length > 0) {
      buffer.blocks = [];
      buffer.id = null;
    }
    return events.length > 0 ? events : null;
  }

  /*
   * 最终结果行。成功时没有可展示内容；但错误子类型（error_during_execution /
   * error_max_turns 等）必须上报 —— 否则 CLI 以 0 退出时宿主会误判为成功。
   * 例：--resume 失效时 CLI 会输出
   * {"type":"result","subtype":"error_during_execution","is_error":true,
   *  "errors":["No conversation found with session ID: ..."]}
   */
  if (type === "result") {
    const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
    const isError = obj.is_error === true || subtype.startsWith("error");
    if (!isError) return null;

    const errors = Array.isArray(obj.errors)
      ? obj.errors.filter((item): item is string => typeof item === "string")
      : [];
    const message =
      errors.join("\n").trim() ||
      (typeof obj.result === "string" ? obj.result.trim() : "") ||
      `Agent 执行失败（${subtype || "unknown"}）`;
    return { type: "error", message };
  }

  // system 记录：只取 api_error / informational，其余无内容可展示
  if (type === "system") return mapSystemRecord(obj);

  return null;
}
