/**
 * 待办事项（SQLite repository）
 *
 * 只包含该领域的 SQL 与行映射；连接与语句缓存见 ../connection。
 */

import { randomUUID } from "crypto";
import { getDb, prepare } from "../connection";
import type { TodoDraft, TodoItem, TodoPriority } from "../../../shared/types";

// ============================================================================
// 待办事项
// ============================================================================

function rowToTodo(row: any): TodoItem {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags_json);
    if (Array.isArray(parsed)) {
      tags = parsed.filter((tag): tag is string => typeof tag === "string");
    }
  } catch {
    // 损坏的标签按空数组处理，不影响条目本身
  }
  const priority: TodoPriority =
    row.priority === "high" || row.priority === "low" ? row.priority : "normal";
  return {
    id: row.id,
    title: row.title,
    note: row.note ?? "",
    priority,
    dueAt: row.due_at ?? null,
    tags,
    done: row.done === 1,
    completedAt: row.completed_at ?? null,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listTodos(): TodoItem[] {
  const rows = getDb()
    .prepare("SELECT * FROM todos ORDER BY sort_order ASC, created_at DESC")
    .all() as any[];
  return rows.map(rowToTodo);
}

export function getTodo(id: string): TodoItem | null {
  const row = prepare("SELECT * FROM todos WHERE id = ?").get(id) as any;
  return row ? rowToTodo(row) : null;
}

export function createTodo(draft: TodoDraft): TodoItem {
  const id = randomUUID();
  const now = Date.now();
  // 新条目排在最前面：取全局最小 sort_order 再减一。
  // 分组展示时，各组的相对顺序仍由各自的 sort_order 决定。
  const min = prepare("SELECT MIN(sort_order) AS value FROM todos").get() as {
    value: number | null;
  };
  const sortOrder = (min.value ?? 0) - 1;

  prepare(
    "INSERT INTO todos (id, title, note, priority, due_at, tags_json, done, completed_at, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)",
  ).run(
    id,
    draft.title,
    draft.note,
    draft.priority,
    draft.dueAt,
    JSON.stringify(draft.tags),
    sortOrder,
    now,
    now,
  );
  return getTodo(id)!;
}

export function updateTodo(id: string, draft: TodoDraft): TodoItem | null {
  const info = getDb()
    .prepare(
      "UPDATE todos SET title = ?, note = ?, priority = ?, due_at = ?, tags_json = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      draft.title,
      draft.note,
      draft.priority,
      draft.dueAt,
      JSON.stringify(draft.tags),
      Date.now(),
      id,
    );
  return info.changes > 0 ? getTodo(id) : null;
}

/** 只切换完成状态，不要求前端回传整份草稿 */
export function setTodoDone(id: string, done: boolean): TodoItem | null {
  const info = getDb()
    .prepare(
      "UPDATE todos SET done = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(done ? 1 : 0, done ? Date.now() : null, Date.now(), id);
  return info.changes > 0 ? getTodo(id) : null;
}

export function deleteTodo(id: string): boolean {
  return prepare("DELETE FROM todos WHERE id = ?").run(id).changes > 0;
}

export function clearCompletedTodos(): number {
  return prepare("DELETE FROM todos WHERE done = 1").run().changes;
}

/**
 * 按传入顺序重写 sort_order。
 * 调用方只传同一分组内的 id，组与组之间的排序值互不影响。
 */
export function reorderTodos(ids: string[]): boolean {
  const now = Date.now();
  const stmt = prepare("UPDATE todos SET sort_order = ?, updated_at = ? WHERE id = ?");
  getDb().transaction(() => {
    ids.forEach((id, index) => stmt.run(index, now, id));
  })();
  return true;
}

export function countPendingTodos(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS value FROM todos WHERE done = 0")
    .get() as { value: number };
  return row.value;
}

