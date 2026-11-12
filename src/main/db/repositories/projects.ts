/**
 * 项目操作（SQLite repository）
 *
 * 只包含该领域的 SQL 与行映射；连接与语句缓存见 ../connection。
 */

import { randomUUID } from "crypto";
import { getDb, prepare } from "../connection";
import type { Project } from "../../../shared/types";

// ============================================================================
// 项目操作
// ============================================================================

export function listProjects(): Project[] {
  const rows = prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as any[];
  return rows.map(rowToProject);
}

export function getProject(id: string): Project | null {
  const row = prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
  return row ? rowToProject(row) : null;
}

export function createProject(name: string, cwd: string): Project {
  const id = randomUUID();
  const now = Date.now();
  prepare(
    "INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, name, cwd, now, now);
  return { id, name, cwd, createdAt: now, updatedAt: now };
}

/**
 * 删除项目及其下所有会话（sessions/messages 经外键级联删除）。
 * CLI 侧会话文件的清理由 IPC handler 在调用本函数前完成。
 */
export function deleteProject(id: string): void {
  // 删除会话、自动化任务与项目包在同一个事务里，保证原子性（任一失败则整体回滚）。
  // 任务不同步清理的话，轮询器之后会对着已不存在的项目反复失败。
  getDb().transaction(() => {
    prepare("DELETE FROM automation_tasks WHERE project_id = ?").run(id);
    prepare("DELETE FROM sessions WHERE project_id = ?").run(id);
    prepare("DELETE FROM projects WHERE id = ?").run(id);
  })();
}

function rowToProject(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

