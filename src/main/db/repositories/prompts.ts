/**
 * 提示词（SQLite repository）
 *
 * 只包含该领域的 SQL 与行映射；连接与语句缓存见 ../connection。
 */

import { randomUUID } from "crypto";
import { getDb, prepare } from "../connection";
import type { PromptDraft, PromptItem } from "../../../shared/types";

// ============================================================================
// 提示词
// ============================================================================

/**
 * tags_json 列仍保留在表里（历史数据不丢），但界面已移除标签功能，
 * 因此不再读取，也不再写入。
 */
function rowToPrompt(row: any): PromptItem {
  return {
    id: row.id,
    title: row.title,
    content: row.content ?? "",
    favorite: row.favorite === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 按最近修改排序。
 *
 * favorite 列仍保留在表里（历史数据不丢），但界面已移除收藏功能，
 * 因此不再参与排序 —— 否则旧收藏会毫无提示地钉在列表顶部。
 */
export function listPrompts(): PromptItem[] {
  const rows = getDb()
    .prepare("SELECT * FROM prompts ORDER BY updated_at DESC, rowid DESC")
    .all() as any[];
  return rows.map(rowToPrompt);
}

export function getPrompt(id: string): PromptItem | null {
  const row = prepare("SELECT * FROM prompts WHERE id = ?").get(id) as any;
  return row ? rowToPrompt(row) : null;
}

export function createPrompt(draft: PromptDraft): PromptItem {
  const id = randomUUID();
  const now = Date.now();
  prepare(
    "INSERT INTO prompts (id, title, content, favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, draft.title, draft.content, draft.favorite ? 1 : 0, now, now);
  return getPrompt(id)!;
}

export function updatePrompt(id: string, draft: PromptDraft): PromptItem | null {
  const info = getDb()
    .prepare(
      "UPDATE prompts SET title = ?, content = ?, favorite = ?, updated_at = ? WHERE id = ?",
    )
    .run(draft.title, draft.content, draft.favorite ? 1 : 0, Date.now(), id);
  return info.changes > 0 ? getPrompt(id) : null;
}

export function deletePrompt(id: string): boolean {
  return prepare("DELETE FROM prompts WHERE id = ?").run(id).changes > 0;
}

