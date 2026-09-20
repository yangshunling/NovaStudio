/**
 * Pi 的会话存储
 *
 * 存储形态：~/.pi/agent/sessions/<子目录>/<timestamp>_<uuid>.jsonl
 * - 会话引用（agentSessionId）= JSONL 文件的绝对路径，pi 的 --session 同时接受 <path|id>
 * - 缓存版本 = 文件 mtime
 *
 * 这些文件系统细节全部收敛在本文件，宿主不感知。
 */

import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { AgentEvent, Message } from "../../../shared/types";
import { textOf } from "./parse";
import { describeTool, isSilentTool } from "../tool-display";

/** 会话根目录 */
function sessionsRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

/**
 * 把 pi 首轮输出的 session id（uuid）升级为会话 JSONL 文件绝对路径。
 *
 * 文件名形如 <timestamp>_<uuid>.jsonl。策略：
 * 1. 快路径：由 cwd 推子目录名（把分隔符统一替换为 "-"）直接命中；
 * 2. 兜底：全量扫描会话根目录下所有子目录，彻底消除命名算法差异。
 */
export function locateSessionFile(cwd: string, sessionId: string): string | null {
  if (!cwd || !sessionId) return null;
  const suffix = `_${sessionId}.jsonl`;
  const root = sessionsRoot();

  // C:\Users\a -> C--Users-a，对应 pi 的 --C--Users-a-- 目录名
  const dashed = cwd.split(/[\\/:]/).join("-");
  const dir = join(root, `--${dashed}--`);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(suffix)) return join(dir, name);
    }
  }

  // 全量兜底
  let subdirs: string[] = [];
  try {
    subdirs = readdirSync(root).filter((s) => s.startsWith("--"));
  } catch {
    return null;
  }
  for (const sub of subdirs) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(root, sub));
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith(suffix)) return join(root, sub, name);
    }
  }
  return null;
}

/** 文件版本号（mtime），供历史缓存失效使用；引用不是文件时返回 null */
export function fileVersion(ref: string): string | null {
  try {
    return String(statSync(ref).mtimeMs);
  } catch {
    return null;
  }
}

/** 会话 JSONL 的单条记录（只声明我们关心的字段） */
interface PiSessionEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    isError?: boolean;
    summary?: string;
  };
}

/**
 * 回放会话 JSONL 为 UI 消息列表。
 * 仅 message 条目参与渲染；toolResult 追加到上一条 assistant 消息
 * （与流式时 tool_result 紧跟 tool_call 的呈现一致）。
 * 文件缺失或解析失败返回空数组。
 */
export function readHistory(ref: string): Message[] {
  if (!ref || !existsSync(ref)) return [];

  let raw: string;
  try {
    raw = readFileSync(ref, "utf8");
  } catch {
    return [];
  }

  const messages: Message[] = [];
  let lastAssistant: Message | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    let entry: PiSessionEntry;
    try {
      entry = JSON.parse(line) as PiSessionEntry;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue; // session / model_change / compaction / label 等跳过

    const m = entry.message;
    if (!m || typeof m.role !== "string") continue;
    const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();

    if (m.role === "user") {
      messages.push({
        id: entry.id ?? "",
        role: "user",
        content: [{ type: "text", content: textOf(m.content) }],
        timestamp,
      });
      lastAssistant = null;
    } else if (m.role === "assistant") {
      const blocks: AgentEvent[] = [];
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "thinking" && typeof b.thinking === "string") {
            blocks.push({ type: "thinking", content: b.thinking });
          } else if (b.type === "text" && typeof b.text === "string") {
            blocks.push({ type: "text", content: b.text });
          } else if (b.type === "toolCall" && typeof b.name === "string") {
            const display = describeTool(b.name, b.arguments);
            if (display) {
              blocks.push({
                type: "tool_call",
                name: b.name,
                input: b.arguments ?? {},
                kind: display.kind,
                target: display.target,
              });
            }
          }
          // redacted_thinking / image 等忽略
        }
      }
      const message: Message = {
        id: entry.id ?? "",
        role: "assistant",
        content: blocks,
        timestamp,
      };
      messages.push(message);
      lastAssistant = message;
    } else if (m.role === "toolResult" && lastAssistant) {
      const name = m.toolName ?? "tool";
      if (isSilentTool(name)) continue;
      lastAssistant.content.push({
        type: "tool_result",
        name,
        output: textOf(m.content),
        isError: !!m.isError,
      });
    } else if (m.role === "bashExecution") {
      // shell 执行：与流式解析同一约定，不进消息流
      continue;
    } else if (m.role === "compactionSummary" && lastAssistant) {
      lastAssistant.content.push({
        type: "text",
        content: `📦 上下文已压缩：${m.summary ?? ""}`,
      });
    }
    // branchSummary / custom / custom_message：暂不渲染
  }
  return messages;
}

/**
 * 删除 pi 会话文件。
 *
 * 只删这一个文件；父目录仅在「空目录」时移除（rmdir 对非空目录会抛错并被忽略）。
 * 绝不做递归删除 —— 同一目录下可能存在其他会话文件。
 */
export function deleteSession(ref: string): void {
  if (!ref || !existsSync(ref)) return;

  try {
    rmSync(ref, { force: true });
  } catch {
    // 清理失败不阻断主流程
  }

  try {
    rmdirSync(dirname(ref));
  } catch {
    // 目录非空或不存在：保留
  }
}
