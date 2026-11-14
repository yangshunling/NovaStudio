/**
 * 自动化任务操作（SQLite repository）
 *
 * 只包含该领域的 SQL 与行映射；连接与语句缓存见 ../connection。
 */

import { randomUUID } from "crypto";
import { prepare } from "../connection";
import type { AutomationStatus, AutomationTask } from "../../../shared/types";

// ============================================================================
// 自动化任务操作
// ============================================================================

export function listAutomationTasks(): AutomationTask[] {
  const rows = prepare("SELECT * FROM automation_tasks ORDER BY created_at DESC").all() as any[];
  return rows.map(rowToAutomationTask);
}

export function getAutomationTask(id: string): AutomationTask | null {
  const row = prepare("SELECT * FROM automation_tasks WHERE id = ?").get(id) as any;
  return row ? rowToAutomationTask(row) : null;
}

/** 按执行会话反查自动化任务（自动化会话在 sessions 表里 source 也是 chat） */
export function getAutomationTaskBySessionId(
  sessionId: string,
): AutomationTask | null {
  const row = prepare(
    "SELECT * FROM automation_tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
  ).get(sessionId) as any;
  return row ? rowToAutomationTask(row) : null;
}

export function createAutomationTask(
  prompt: string,
  projectId: string,
  agentId: string,
  employeeId: string | null = null,
): AutomationTask {
  const id = randomUUID();
  const now = Date.now();
  prepare(
    "INSERT INTO automation_tasks (id, prompt, project_id, agent_id, employee_id, status, session_id, created_at, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, prompt, projectId, agentId, employeeId, "pending", null, now, null, null, null);
  return { id, prompt, projectId, agentId, employeeId, status: "pending", sessionId: null, createdAt: now, startedAt: null, completedAt: null, error: null };
}

export function updateAutomationTask(id: string, fields: Partial<Omit<AutomationTask, "id" | "prompt" | "projectId" | "agentId" | "createdAt">>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.employeeId !== undefined) { sets.push("employee_id = ?"); vals.push(fields.employeeId); }
  if (fields.status !== undefined) { sets.push("status = ?"); vals.push(fields.status); }
  if (fields.sessionId !== undefined) { sets.push("session_id = ?"); vals.push(fields.sessionId); }
  if (fields.startedAt !== undefined) { sets.push("started_at = ?"); vals.push(fields.startedAt); }
  if (fields.completedAt !== undefined) { sets.push("completed_at = ?"); vals.push(fields.completedAt); }
  if (fields.error !== undefined) { sets.push("error = ?"); vals.push(fields.error); }
  if (sets.length === 0) return;
  vals.push(id);
  prepare(`UPDATE automation_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function deleteAutomationTask(id: string): void {
  prepare("DELETE FROM automation_tasks WHERE id = ?").run(id);
}

function rowToAutomationTask(row: any): AutomationTask {
  return {
    id: row.id,
    prompt: row.prompt,
    projectId: row.project_id,
    agentId: row.agent_id,
    employeeId: row.employee_id ?? null,
    status: row.status as AutomationStatus,
    sessionId: row.session_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

