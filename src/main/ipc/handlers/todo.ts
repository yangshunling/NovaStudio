/**
 * 待办事项 IPC
 *
 * 个人清单的增删改查，与工作区 / 工作流没有任何关系。
 * 每次写操作后推送未完成数量，侧栏角标据此更新。
 */

import * as db from "../../db/sqlite";
import { handle } from "../register";
import { push } from "../push";
import type { TodoDraft, TodoPriority } from "../../../shared/types";

/** 单条待办最多保留的标签数，避免标签墙 */
const MAX_TAGS = 8;
const MAX_TITLE_LENGTH = 200;
const MAX_NOTE_LENGTH = 5000;

/** 去掉 # 前缀、空标签与大小写重复项，顺序保持用户输入顺序 */
function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().replace(/^#+/, "");
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function normalizeDraft(draft: TodoDraft): TodoDraft {
  const title = (draft.title ?? "").trim();
  if (!title) throw new Error("待办内容不能为空");
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error(`待办内容不能超过 ${MAX_TITLE_LENGTH} 个字符`);
  }

  const priority: TodoPriority =
    draft.priority === "high" || draft.priority === "low"
      ? draft.priority
      : "normal";

  return {
    title,
    note: (draft.note ?? "").trim().slice(0, MAX_NOTE_LENGTH),
    priority,
    dueAt:
      typeof draft.dueAt === "number" && Number.isFinite(draft.dueAt)
        ? draft.dueAt
        : null,
    tags: normalizeTags(draft.tags),
  };
}

/** 写操作后同步侧栏角标 */
function notifyCount(): void {
  push("todos:changed", { pending: db.countPendingTodos() });
}

export function registerTodoHandlers(): void {
  handle("todos:list", () => db.listTodos());

  handle("todos:create", ({ draft }) => {
    const item = db.createTodo(normalizeDraft(draft));
    notifyCount();
    return item;
  });

  handle("todos:update", ({ id, draft }) => {
    const item = db.updateTodo(id, normalizeDraft(draft));
    if (item) notifyCount();
    return item;
  });

  handle("todos:toggle", ({ id, done }) => {
    const item = db.setTodoDone(id, Boolean(done));
    if (item) notifyCount();
    return item;
  });

  handle("todos:delete", ({ id }) => {
    const deleted = db.deleteTodo(id);
    if (deleted) notifyCount();
    return deleted;
  });

  handle("todos:clearCompleted", () => {
    const count = db.clearCompletedTodos();
    if (count > 0) notifyCount();
    return count;
  });

  // 排序不改变完成状态，无需推送角标
  handle("todos:reorder", ({ ids }) => db.reorderTodos(ids));
}
