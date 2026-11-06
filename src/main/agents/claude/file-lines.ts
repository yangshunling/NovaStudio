/**
 * 实时运行时的 diff 行号定位
 *
 * tool_use 事件在工具真正执行**之前**到达，此刻磁盘上还是改动前的文件，
 * 因此把 old_string 在文件里定位一次，就能得到变更在旧文件中的真实行号。
 * 定位不到（文件被删 / 内容已被后续改动覆盖）时返回 undefined —— 展示层
 * 会不画行号，而不是从 1 开始编造。
 *
 * 历史回放不走这里：Claude 会话 JSONL 的 toolUseResult 自带 structuredPatch，
 * 有更精确的行号（见 sessions.ts）。
 */

import { readFileSync, statSync } from "fs";
import { resolve } from "path";
import type { LineStartsResolver } from "./parse";

/** 超过这个大小的文件不做定位：读进来只为找一段文本，不值得 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function createLineStartsResolver(cwd: string): LineStartsResolver {
  return (name, input) => {
    if (!input || typeof input !== "object") return undefined;
    const record = input as Record<string, unknown>;
    const tool = name.toLowerCase();
    const filePath = readPath(record);
    if (!filePath) return undefined;

    // 整文件写入从第 1 行开始，行号是确定的
    if (tool === "write" || tool === "notebookedit") return [1];
    if (tool !== "edit" && tool !== "multiedit") return undefined;

    const content = readText(resolve(cwd, filePath));
    if (content === null) return undefined;

    if (tool === "edit") {
      const start = locate(
        content,
        asText(record.old_string),
        asText(record.new_string),
      );
      return start === null ? undefined : [start];
    }

    const edits = Array.isArray(record.edits) ? record.edits : [];
    if (edits.length === 0) return undefined;
    const starts: number[] = [];
    for (const edit of edits) {
      const item = (edit && typeof edit === "object" ? edit : {}) as Record<string, unknown>;
      const start = locate(content, asText(item.old_string), asText(item.new_string));
      // 任何一段定位失败就整组放弃，避免部分行号错位
      if (start === null) return undefined;
      starts.push(start);
    }
    return starts;
  };
}

/**
 * 定位一次替换的起始行。
 *
 * 正常情况下磁盘上还是改动前的内容，按 old_string 定位；但解析与执行之间
 * 存在竞态（小文件可能已经被改写），此时退回用 new_string 定位 —— 替换后
 * 新旧内容在同一位置开始，行号一致。
 */
function locate(content: string, oldText: string | null, newText: string | null): number | null {
  if (oldText) {
    const start = lineOfText(content, oldText);
    if (start !== null) return start;
  }
  if (newText) return lineOfText(content, newText);
  return null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function readPath(record: Record<string, unknown>): string | null {
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function readText(file: string): string | null {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** 一段文本在文件中的起始行号（1-based）；找不到返回 null */
export function lineOfText(content: string, snippet: string): number | null {
  // 统一换行符：Windows 上文件常是 CRLF，而工具参数里是 LF
  const haystack = content.replace(/\r\n?/g, "\n");
  const needle = snippet.replace(/\r\n?/g, "\n");
  if (!needle) return null;
  const index = haystack.indexOf(needle);
  if (index < 0) return null;
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (haystack.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
