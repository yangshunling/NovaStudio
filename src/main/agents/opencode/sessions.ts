/**
 * OpenCode 的会话存储
 *
 * 与 pi 的关键差异：会话数据存放在 OpenCode 自己的数据库里（不是文件），
 * 因此历史读取与删除都必须通过 CLI 完成。
 * 这些细节全部收敛在本文件，宿主不感知。
 */

import type { Message } from "../../../shared/types";
import { execCliSync } from "../transport";
import { parseExportMessages } from "./parse";

const BIN = "opencode";
const EXPORT_TIMEOUT_MS = 15_000;
const DELETE_TIMEOUT_MS = 5_000;

/** 导出会话并解析为消息列表；失败返回空数组 */
export function readHistory(ref: string): Message[] {
  if (!ref) return [];
  try {
    const json = execCliSync([BIN, "export", ref], EXPORT_TIMEOUT_MS);
    const data = JSON.parse(json) as { messages?: unknown[] };
    return parseExportMessages(data.messages ?? []);
  } catch {
    return [];
  }
}

/** 删除 OpenCode 侧会话；失败静默，不阻断主流程 */
export function deleteSession(ref: string): void {
  if (!ref) return;
  try {
    execCliSync([BIN, "session", "delete", ref], DELETE_TIMEOUT_MS);
  } catch {
    // 静默失败
  }
}
