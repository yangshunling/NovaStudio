/**
 * 文件系统小工具
 */

import {
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { open, rename, rm, stat, writeFile } from "fs/promises";
import { normalizeNewlines } from "../../shared/text";

/** cp 过滤：不复制 VCS 元数据与系统垃圾文件 */
export function copyFilter(source: string): boolean {
  const name = source.split(/[\\/]/).pop() ?? source;
  return name !== ".git" && name !== ".DS_Store";
}

export interface TextFileSnapshot {
  /** 文本内容（行尾统一为 \n）；二进制文件为空串 */
  content: string;
  size: number;
  updatedAt: number;
  /** 文件超过读取上限，content 只是前 limit 字节 */
  truncated: boolean;
  /** 前 8KB 出现 NUL，视为二进制 */
  binary: boolean;
}

let tempCounter = 0;

/** 同目录临时文件：唯一后缀避免并发写互相覆盖 */
function tempPath(path: string): string {
  tempCounter += 1;
  return `${path}.nova-tmp-${process.pid}-${tempCounter}`;
}

/** 原子写文本文件：临时文件 + rename，进程崩溃不会留下半截内容 */
export function writeFileAtomicSync(path: string, content: string): void {
  const temp = tempPath(path);
  try {
    writeFileSync(temp, content, "utf8");
    renameSync(temp, path);
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // 清理临时文件失败不掩盖原始错误
    }
    throw err;
  }
}

/** 原子写文本文件的异步版本 */
export async function writeFileAtomic(
  path: string,
  content: string,
): Promise<void> {
  const temp = tempPath(path);
  try {
    await writeFile(temp, content, "utf8");
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/** 写入文本文件；超过 maxBytes 时直接拒绝，错误文案由调用方决定 */
export async function writeTextFileLimited(
  path: string,
  content: string,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    return { ok: false, error: tooLargeMessage };
  }
  try {
    await writeFileAtomic(path, content);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 读取文本文件，最多读 limit 字节。
 *
 * - 只读前 limit 字节，避免大文件把主进程内存拖垮；
 * - 行尾统一为 \n：`<textarea>` 会把 CRLF 归一化成 LF，不统一的话
 *   编辑器会把「改回原样」误判成仍有改动；
 * - 简单二进制探测：前 8KB 出现 NUL 即视为不可编辑。
 */
export async function readTextFileLimited(
  path: string,
  limit: number,
): Promise<TextFileSnapshot | null> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;

  try {
    const length = Math.min(info.size, limit);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      const binary = buffer.subarray(0, 8192).includes(0);
      return {
        content: binary ? "" : normalizeNewlines(buffer.toString("utf8")),
        size: info.size,
        updatedAt: info.mtimeMs,
        truncated: info.size > limit,
        binary,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
