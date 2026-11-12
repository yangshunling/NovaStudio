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

import { cp, mkdir, readFile, readdir, rm, rmdir, stat } from "fs/promises";
import { basename, dirname, join } from "path";
import type { AgentEvent, Message } from "../../../shared/types";
import {
  mapAssistantBlocks,
  mapSystemRecord,
  mapToolResultBlocks,
  type CallNames,
} from "./parse";
import { claudeConfigDir } from "./config";
import { lineOfText } from "./file-lines";
import { parseJsonSafe } from "../../../shared/json";

/**
 * 会话根目录。
 * 普通会话没有 configDir，沿用 ~/.claude；工作流节点会传入独立配置目录，
 * 此时 Claude 会把会话写到 <configDir>/projects 下。
 */
function projectsRoot(configDir?: string | null): string {
  /*
   * 必须与 CLI 使用同一套配置根目录：宿主进程设置了 CLAUDE_CONFIG_DIR 时，
   * CLI 会把会话写到该目录下，而不是 ~/.claude。否则历史回放与删除会
   * 静默找错位置（configInfo / settings / MCP 都认这个环境变量）。
   */
  return join(configDir || claudeConfigDir(), "projects");
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
export async function locateSessionFile(
  cwd: string,
  sessionId: string,
  configDir?: string | null,
): Promise<string | null> {
  if (!cwd || !sessionId) return null;
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const root = projectsRoot(configDir);
  const file = `${sessionId}.jsonl`;

  const fast = join(root, encodeCwd(cwd), file);
  if (await exists(fast)) return fast;

  let dirs: string[] = [];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, file);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/**
 * 把旧配置目录里的会话 JSONL 复制到新的共享 projects 目录。
 *
 * 会话运行时切换 home 后，所有 home 的 projects 都指向同一个目录；
 * 迁移老会话时只需把文件搬到这里一次。
 * 目标已存在时直接返回 true，避免把新产生的对话覆盖成旧文件。
 */
export async function copySessionFileToProjects(
  ref: string,
  cwd: string,
  configDir: string | null,
  projectsDir: string,
): Promise<boolean> {
  // 快路径：新会话已经是按当前 cwd 编码写入的
  const encoded = encodeCwd(cwd);
  const fastTarget = join(projectsDir, encoded, `${ref}.jsonl`);
  if (await exists(fastTarget)) return true;

  const source = await locateSessionFile(cwd, ref, configDir);
  if (!source) return false;

  /*
   * 保留旧文件所在的目录名，而不是重新编码 cwd。
   * Windows 上 claude 生成的目录名大小写不稳定，沿用旧名字能让
   * --resume 的快路径继续命中。
   */
  const target = join(
    projectsDir,
    basename(dirname(source)),
    `${ref}.jsonl`,
  );
  if (await exists(target)) return true;

  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { force: true });
  return true;
}

/** 文件版本号（mtime），供历史缓存失效使用；引用定位不到时返回 null */
export async function fileVersion(
  ref: string,
  cwd: string,
  configDir?: string | null,
): Promise<string | null> {
  const file = await locateSessionFile(cwd, ref, configDir);
  if (!file) return null;
  try {
    const info = await stat(file);
    return String(info.mtimeMs);
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 会话 id 只允许 UUID 常见字符。
 * 它会直接拼进文件路径，必须挡住 `/`、`\`、`.` 等分隔符，
 * 否则 `"../../x"` 这类 id 能让读取 / 删除跑到会话目录之外。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** structuredPatch 的一个 hunk（行号 + 带 +/-/空格前缀的行） */
interface ClaudePatchHunk {
  oldStart?: number;
  newStart?: number;
  lines?: unknown;
}

/**
 * 工具回执附带的结构化结果。会话文件把它写在同一条 user 记录上，
 * 这里只取定位行号需要的字段。
 */
interface ClaudeToolUseResult {
  oldString?: string;
  originalFile?: string;
  structuredPatch?: ClaudePatchHunk[];
}

/** 会话 JSONL 的单条记录（只声明我们关心的字段） */
interface ClaudeSessionEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  /** 子代理（Task 工具）产生的对话，不属于主对话 */
  isSidechain?: boolean;
  /** 系统注入的用户消息（local-command-caveat、图片尺寸说明等），不是用户发言 */
  isMeta?: boolean;
  /** 上下文压缩摘要，不是用户输入 */
  isCompactSummary?: boolean;
  /** API 错误的 assistant 记录：正文是错误信息，应显示为错误而不是普通发言 */
  isApiErrorMessage?: boolean;
  error?: unknown;
  /** system 记录：api_error / informational 等子类型及其正文 */
  subtype?: unknown;
  content?: unknown;
  level?: unknown;
  message?: { role?: string; content?: unknown };
  toolUseResult?: ClaudeToolUseResult;
}

/**
 * 回放会话 JSONL 为 UI 消息列表。
 * 仅 user / assistant 记录参与渲染；工具回执追加到上一条 assistant 消息
 * （与流式时 tool_result 紧跟 tool_call 的呈现一致）。
 * 文件缺失或解析失败返回空数组。
 */
export async function readHistory(
  ref: string,
  cwd: string,
  configDir?: string | null,
): Promise<Message[]> {
  const file = await locateSessionFile(cwd, ref, configDir);
  if (!file) return [];

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }

  const names: CallNames = new Map();
  const messages: Message[] = [];
  let lastAssistant: Message | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    const entry = parseJsonSafe<ClaudeSessionEntry | null>(line, null);
    if (!entry) continue;
    if (entry.isSidechain) continue; // 子代理对话不进主视图
    const content = entry.message?.content;
    // system 记录的正文在顶层 content，不在 message 里
    if (content === undefined && entry.type !== "system") continue;
    const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();

    if (entry.type === "user") {
      // 系统注入的 meta 消息与压缩摘要都不是用户发言，混进对话只会制造噪声
      if (entry.isMeta || entry.isCompactSummary) continue;

      if (typeof content === "string") {
        messages.push({
          id: entry.uuid ?? "",
          role: "user",
          content: [{ type: "text", content }],
          timestamp,
        });
        lastAssistant = null;
      } else if (Array.isArray(content)) {
        // 数组内容里既可能是工具回执，也可能是真实用户输入：
        // 带图提问的正文、以及「Request interrupted by user」这类中断标记都放在这里。
        // 之前只取 tool_result，导致这些记录整段丢失。
        const text = userTextBlocks(content);
        if (text) {
          messages.push({
            id: entry.uuid ?? "",
            role: "user",
            content: [{ type: "text", content: text }],
            timestamp,
          });
        }
        if (lastAssistant) {
          // 工具回执追加到最后一条 assistant 消息；顺带把结构化结果里的真实行号
          // 补到对应调用上。并行工具调用的回执可能晚于后续 assistant 记录到达，
          // 所以按 callId 在整个已回放的消息里找。
          lastAssistant.content.push(...mapToolResultBlocks(content, names));
          attachLineStarts(messages, content, entry.toolUseResult);
        }
        if (text) lastAssistant = null;
      }
    } else if (entry.type === "assistant") {
      // API 错误记录：正文是错误信息，显示成普通助手发言会被误读成模型输出
      if (entry.isApiErrorMessage || typeof entry.error === "string") {
        const errorText = assistantErrorText(entry);
        if (errorText) {
          messages.push({
            id: entry.uuid ?? "",
            role: "assistant",
            content: [{ type: "error", message: errorText }],
            timestamp,
          });
        }
        lastAssistant = null;
        continue;
      }

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
    } else if (entry.type === "system") {
      // api_error / informational：错误或提示要进历史，否则用户只看到对话“莫名中断”。
      // 追加到上一条 assistant 消息后，没有则单独成条；不改变 lastAssistant，
      // 避免后续 tool_result 错挂到提示消息上。
      const event = mapSystemRecord(entry);
      if (!event) continue;
      if (lastAssistant) {
        lastAssistant.content.push(event);
      } else {
        messages.push({
          id: entry.uuid ?? "",
          role: "assistant",
          content: [event],
          timestamp,
        });
      }
    }
    // attachment / queue-operation / atis-latch 等系统记录跳过
  }
  return messages;
}

/** user 数组 content 里的 text 块：带图提问的正文、中断标记等真实用户输入 */
function userTextBlocks(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const record = block as { type?: unknown; text?: unknown };
      if (record.type === "text" && typeof record.text === "string" && record.text) {
        parts.push(record.text);
      }
    }
  }
  return parts.join("\n").trim();
}

/** API 错误 assistant 记录的错误文案：优先取 content 里的 text 块，其次取 error 字段 */
function assistantErrorText(entry: ClaudeSessionEntry): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const text = userTextBlocks(content);
    if (text) return text;
  }
  return typeof entry.error === "string" && entry.error
    ? `API 错误（${entry.error}）`
    : "";
}

/**
 * 把「改动在文件中的起始行号」补到已渲染的 tool_call 事件上。
 *
 * 会话文件在同一条 user 记录里同时保存了 tool_result 与 toolUseResult：
 * - Edit：originalFile（改动前的整份文件）+ oldString，可直接定位，最精确
 * - Write：整文件写入，恒从第 1 行开始
 * - 兜底：structuredPatch 的 hunk 行号（跳过 hunk 头部上下文行）
 */
function attachLineStarts(
  messages: Message[],
  content: unknown,
  result: ClaudeToolUseResult | undefined,
): void {
  if (!result) return;
  const callId = toolResultCallId(content);
  if (!callId) return;

  const target = findToolCall(messages, callId);
  if (!target) return;

  const name = target.name.toLowerCase();
  if (name === "write" || name === "notebookedit") {
    target.lineStarts = [1];
    return;
  }
  if (name !== "edit" && name !== "multiedit") return;

  const starts = resolveLineStarts(result);
  if (starts) target.lineStarts = starts;
}

/** 按 callId 在所有已回放消息里找对应的 tool_call */
function findToolCall(
  messages: Message[],
  callId: string,
): Extract<AgentEvent, { type: "tool_call" }> | null {
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const events = messages[m].content;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type === "tool_call" && event.callId === callId) return event;
    }
  }
  return null;
}

/** user 记录里第一个 tool_result 的 id */
function toolResultCallId(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: unknown; tool_use_id?: unknown };
    if (record.type === "tool_result" && typeof record.tool_use_id === "string") {
      return record.tool_use_id;
    }
  }
  return null;
}

function resolveLineStarts(result: ClaudeToolUseResult): number[] | undefined {
  if (typeof result.oldString === "string" && typeof result.originalFile === "string") {
    const start = lineOfText(result.originalFile, result.oldString);
    if (start !== null) return [start];
  }
  return patchLineStarts(result.structuredPatch);
}

/** structuredPatch → 每个 hunk 中第一处变更的行号 */
function patchLineStarts(patch: ClaudePatchHunk[] | undefined): number[] | undefined {
  if (!Array.isArray(patch) || patch.length === 0) return undefined;
  const starts: number[] = [];
  for (const hunk of patch) {
    const start = hunkStartLine(hunk);
    if (start === null) return undefined;
    starts.push(start);
  }
  return starts;
}

function hunkStartLine(hunk: ClaudePatchHunk | null | undefined): number | null {
  if (!hunk || typeof hunk !== "object") return null;
  const lines = Array.isArray(hunk.lines) ? hunk.lines : [];
  // hunk 头部可能带着改动前/后的上下文行，要跳过去才能得到第一处变更
  const changed = lines.findIndex(
    (line) => typeof line === "string" && (line.startsWith("-") || line.startsWith("+")),
  );
  if (changed < 0) return null;

  const first = lines[changed] as string;
  // 纯新增用新文件行号，删除 / 替换用旧文件行号
  const base = first.startsWith("+") ? hunk.newStart : hunk.oldStart;
  const start = Number(base);
  return Number.isFinite(start) ? Math.max(1, start + changed) : null;
}

/**
 * 删除 claude 会话文件。
 *
 * 只删这一个文件；父目录仅在「空目录」时移除（rmdir 对非空目录会抛错并被忽略）。
 * 绝不做递归删除 —— 同一目录下可能存在其他会话文件。
 */
export async function deleteSession(
  ref: string,
  cwd: string,
  configDir?: string | null,
): Promise<void> {
  const file = await locateSessionFile(cwd, ref, configDir);
  if (!file || !(await exists(file))) return;

  try {
    await rm(file, { force: true });
  } catch {
    // 清理失败不阻断主流程
  }

  try {
    await rmdir(dirname(file));
  } catch {
    // 目录非空或不存在：保留
  }
}
