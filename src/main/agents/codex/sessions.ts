/**
 * Codex 的会话存储
 *
 * 存储形态：~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<时间戳>-<threadId>.jsonl
 * - 会话引用（agentSessionId）= thread_id（uuid）—— `codex exec resume <id>` 收的就是它；
 *   文件路径只在回放历史 / 清理数据时才需要，由本文件按 id 现找
 * - 缓存版本 = 文件 mtime
 *
 * rollout 是 Codex 自己的记录格式（每行一个 JSON 对象）：
 *   {"type":"session_meta",...} / {"type":"event_msg","payload":{...}}   生命周期与用量，忽略
 *   {"type":"response_item","payload":{...}}                            对话内容
 * payload 的形态：
 *   {"type":"message","role":"user"|"assistant"|"developer",
 *    "content":[{"type":"input_text"|"output_text","text":"..."}],
 *    "internal_chat_message_metadata_passthrough":{"content_item_kinds":["user.text"]}}
 *   {"type":"function_call","name":"exec_command","arguments":"<JSON 字符串>"}
 *   {"type":"function_call_output","output":"..."}
 *
 * 两点取舍（都收敛在本文件，宿主不感知）：
 * 1. 只有 content_item_kinds 含 "user.text" 的 user 消息才算真实用户提问 ——
 *    Codex 会把环境上下文、技能清单、权限说明等以 developer / user 角色注入，
 *    它们不该出现在对话历史里。
 * 2. function_call / function_call_output 不参与回放：rollout 存的是原始函数调用
 *    （exec_command / apply_patch …），与 --json 流里的语义条目（file_change …）
 *    并非一一对应，硬映射会把命令噪声灌进历史。历史只保留对话正文。
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Message } from "../../../shared/types";
import { execCliSync } from "../transport";

const BIN = "codex";
const DELETE_TIMEOUT_MS = 10_000;

/** 会话根目录 */
function sessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

/**
 * 按 thread id 定位 rollout 文件。
 * 目录按年 / 月 / 日分级，文件名以 `-<threadId>.jsonl` 结尾；
 * thread id 全局唯一，按文件名匹配即可，不必还原目录结构。
 */
export function locateRolloutFile(threadId: string): string | null {
  if (!threadId) return null;
  const root = sessionsRoot();
  const suffix = `-${threadId}.jsonl`;

  let entries: string[] = [];
  try {
    entries = readdirSync(root, { recursive: true, encoding: "utf8" });
  } catch {
    return null;
  }
  const hit = entries.find((name) => name.endsWith(suffix));
  return hit ? join(root, hit) : null;
}

/** 文件版本号（mtime），供历史缓存失效使用；引用定位不到时返回 null */
export function fileVersion(ref: string): string | null {
  const file = locateRolloutFile(ref);
  if (!file) return null;
  try {
    return String(statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

/** rollout 的单条记录（只声明我们关心的字段） */
interface RolloutRecord {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    id?: string;
    role?: string;
    content?: unknown;
    internal_chat_message_metadata_passthrough?: { content_item_kinds?: string[] };
  };
}

/** 从 content 提取文本（content 是 [{type:"input_text"|"output_text",text}]） */
function textOf(content: unknown): string {
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

/** 该 user 消息是否是真实用户提问（而非 CLI 注入的环境上下文等） */
function isUserPrompt(record: RolloutRecord["payload"]): boolean {
  const kinds = record?.internal_chat_message_metadata_passthrough?.content_item_kinds;
  return Array.isArray(kinds) && kinds.includes("user.text");
}

/**
 * 回放 rollout 为 UI 消息列表：只取用户提问与助手正文。
 * 文件缺失或解析失败返回空数组。
 */
export function readHistory(ref: string): Message[] {
  const file = locateRolloutFile(ref);
  if (!file) return [];

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const messages: Message[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    let record: RolloutRecord;
    try {
      record = JSON.parse(line) as RolloutRecord;
    } catch {
      continue;
    }
    if (record.type !== "response_item") continue;
    const payload = record.payload;
    if (!payload || payload.type !== "message") continue;

    const isUser = payload.role === "user" && isUserPrompt(payload);
    const isAssistant = payload.role === "assistant";
    if (!isUser && !isAssistant) continue;

    const text = textOf(payload.content);
    if (!text) continue;

    messages.push({
      id: payload.id ?? "",
      role: isUser ? "user" : "assistant",
      content: [{ type: "text", content: text }],
      timestamp: record.timestamp ? Date.parse(record.timestamp) : Date.now(),
    });
  }
  return messages;
}

/** 删除 Codex 侧会话（rollout 文件与索引一并清理）；失败静默，不阻断主流程 */
export function deleteSession(ref: string): void {
  if (!ref) return;
  try {
    execCliSync([BIN, "delete", ref, "--force"], DELETE_TIMEOUT_MS);
  } catch {
    // 清理失败不阻断主流程
  }
}
