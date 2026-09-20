/**
 * Claude Code 的会话存储
 *
 * 存储形态：~/.claude/projects/<cwd 转义名>/<session-uuid>.jsonl
 * - cwd 转义：把 \ / : 全部替换为 "-"（C:\Users\a -> C--Users-a）
 * - 会话引用（agentSessionId）保持 uuid 原样 —— claude --resume 接受的是会话 id；
 *   文件路径只在回放历史 / 清理数据时才需要，由本文件按 cwd 现算
 * - 缓存版本 = 文件 mtime
 *
 * 会话 JSONL 的记录（只声明我们关心的字段）：
 *   {"type":"user"|"assistant","message":{"role":...,"content":...},
 *    "uuid":"...","timestamp":"...","isSidechain":false}
 *   {"type":"attachment"|"queue-operation"|"atis-latch"|...}              系统记录，忽略
 * 其中 user 记录的 content 为字符串时是用户输入，为数组时是工具回执
 * （[{type:"tool_result",tool_use_id,content,is_error}]）。
 *
 * 这些文件系统细节全部收敛在本文件，宿主不感知。
 */

import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { AgentEvent, Message } from "../../../shared/types";
import { mapAssistantBlocks, mapToolResultBlocks, type CallNames } from "./parse";

/** 会话根目录 */
function projectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/** cwd → 目录名（与 claude 自己的转义一致：\ / : 一律变成 -） */
function encodeCwd(cwd: string): string {
  return cwd.split(/[\\/:]/).join("-");
}

/**
 * 定位会话 JSONL 文件。
 * 1. 快路径：由 cwd 推目录名直接命中；
 * 2. 兜底：全量扫描。实测 Windows 上 claude 生成的目录名大小写并不稳定
 *    （同一个盘符可能写成 C-- 也可能写成 c--），所以不能只靠字符串相等；
 *    会话 uuid 全局唯一，按文件名扫描不会误命中。
 */
export function locateSessionFile(cwd: string, sessionId: string): string | null {
  if (!cwd || !sessionId) return null;
  const root = projectsRoot();
  const file = `${sessionId}.jsonl`;

  const fast = join(root, encodeCwd(cwd), file);
  if (existsSync(fast)) return fast;

  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 文件版本号（mtime），供历史缓存失效使用；引用定位不到时返回 null */
export function fileVersion(ref: string, cwd: string): string | null {
  const file = locateSessionFile(cwd, ref);
  if (!file) return null;
  try {
    return String(statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

/** 会话 JSONL 的单条记录（只声明我们关心的字段） */
interface ClaudeSessionEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  /** 子代理（Task 工具）产生的对话，不属于主对话 */
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

/**
 * 回放会话 JSONL 为 UI 消息列表。
 * 仅 user / assistant 记录参与渲染；工具回执追加到上一条 assistant 消息
 * （与流式时 tool_result 紧跟 tool_call 的呈现一致）。
 * 文件缺失或解析失败返回空数组。
 */
export function readHistory(ref: string, cwd: string): Message[] {
  const file = locateSessionFile(cwd, ref);
  if (!file) return [];

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const names: CallNames = new Map();
  const messages: Message[] = [];
  let lastAssistant: Message | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    let entry: ClaudeSessionEntry;
    try {
      entry = JSON.parse(line) as ClaudeSessionEntry;
    } catch {
      continue;
    }
    if (entry.isSidechain) continue; // 子代理对话不进主视图
    const content = entry.message?.content;
    if (content === undefined) continue;
    const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();

    if (entry.type === "user") {
      if (typeof content === "string") {
        messages.push({
          id: entry.uuid ?? "",
          role: "user",
          content: [{ type: "text", content }],
          timestamp,
        });
        lastAssistant = null;
      } else if (lastAssistant) {
        // 数组内容 = 工具回执
        lastAssistant.content.push(...mapToolResultBlocks(content, names));
      }
    } else if (entry.type === "assistant") {
      const blocks: AgentEvent[] = mapAssistantBlocks(content, names);
      // 整条只剩不展示的工具（Bash 等）时，块为空；与流式时不发事件保持一致，
      // 不进消息流（否则会多出一个空气泡）
      if (blocks.length === 0) continue;
      const message: Message = {
        id: entry.uuid ?? "",
        role: "assistant",
        content: blocks,
        timestamp,
      };
      messages.push(message);
      lastAssistant = message;
    }
    // attachment / queue-operation / atis-latch 等系统记录跳过
  }
  return messages;
}

/**
 * 删除 claude 会话文件。
 *
 * 只删这一个文件；父目录仅在「空目录」时移除（rmdir 对非空目录会抛错并被忽略）。
 * 绝不做递归删除 —— 同一目录下可能存在其他会话文件。
 */
export function deleteSession(ref: string, cwd: string): void {
  const file = locateSessionFile(cwd, ref);
  if (!file || !existsSync(file)) return;

  try {
    rmSync(file, { force: true });
  } catch {
    // 清理失败不阻断主流程
  }

  try {
    rmdirSync(dirname(file));
  } catch {
    // 目录非空或不存在：保留
  }
}
