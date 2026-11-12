/**
 * 工作流触发器（SQLite repository）
 *
 * 只包含该领域的 SQL 与行映射；连接与语句缓存见 ../connection。
 */

import { randomUUID } from "crypto";
import { getDb, prepare } from "../connection";
import type { WorkflowTrigger, WorkflowTriggerBinding, WorkflowTriggerDraft } from "../../../shared/types";
import { normalizeTriggerSchedule } from "../../../shared/trigger-schedule";

// ============================================================================
// 工作流触发器
// ============================================================================

function rowToWorkflowTrigger(row: any): WorkflowTrigger {
  let rawSchedule: unknown = null;
  try {
    rawSchedule = JSON.parse(row.schedule_json);
  } catch {
    // 损坏的规则回退到默认值（normalize 内部兜底）
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    schedule: normalizeTriggerSchedule(rawSchedule),
    enabled: row.enabled === 1,
    lastFiredAt: row.last_fired_at ?? null,
    nextFireAt: row.next_fire_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWorkflowTriggers(): WorkflowTrigger[] {
  const rows = getDb()
    .prepare("SELECT * FROM workflow_triggers ORDER BY created_at DESC")
    .all() as any[];
  return rows.map(rowToWorkflowTrigger);
}

export function getWorkflowTrigger(id: string): WorkflowTrigger | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_triggers WHERE id = ?")
    .get(id) as any;
  return row ? rowToWorkflowTrigger(row) : null;
}

export function createWorkflowTrigger(
  draft: WorkflowTriggerDraft,
  nextFireAt: number | null,
): WorkflowTrigger {
  const id = randomUUID();
  const now = Date.now();
  prepare(
    "INSERT INTO workflow_triggers (id, title, description, schedule_json, enabled, last_fired_at, next_fire_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    draft.title,
    draft.description,
    JSON.stringify(draft.schedule),
    draft.enabled ? 1 : 0,
    null,
    nextFireAt,
    now,
    now,
  );
  return getWorkflowTrigger(id)!;
}

export function updateWorkflowTrigger(
  id: string,
  draft: WorkflowTriggerDraft,
  nextFireAt: number | null,
): WorkflowTrigger | null {
  const info = getDb()
    .prepare(
      "UPDATE workflow_triggers SET title = ?, description = ?, schedule_json = ?, enabled = ?, next_fire_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      draft.title,
      draft.description,
      JSON.stringify(draft.schedule),
      draft.enabled ? 1 : 0,
      nextFireAt,
      Date.now(),
      id,
    );
  return info.changes > 0 ? getWorkflowTrigger(id) : null;
}

/** 只更新运行状态字段（调度器触发后 / 启动时重算下次时间用） */
export function updateWorkflowTriggerRuntime(
  id: string,
  patch: {
    lastFiredAt?: number;
    nextFireAt?: number | null;
    lastError?: string | null;
  },
): WorkflowTrigger | null {
  const current = getWorkflowTrigger(id);
  if (!current) return null;

  prepare(
    "UPDATE workflow_triggers SET last_fired_at = ?, next_fire_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
  ).run(
    patch.lastFiredAt !== undefined ? patch.lastFiredAt : current.lastFiredAt,
    patch.nextFireAt !== undefined ? patch.nextFireAt : current.nextFireAt,
    patch.lastError !== undefined ? patch.lastError : current.lastError,
    Date.now(),
    id,
  );
  return getWorkflowTrigger(id);
}

export function deleteWorkflowTrigger(id: string): boolean {
  let deleted = false;
  getDb().transaction(() => {
    prepare("DELETE FROM workflow_trigger_bindings WHERE trigger_id = ?").run(
      id,
    );
    deleted =
      prepare("DELETE FROM workflow_triggers WHERE id = ?").run(id).changes >
      0;
  })();
  return deleted;
}

export function listWorkflowTriggerBindings(): WorkflowTriggerBinding[] {
  const rows = getDb()
    .prepare("SELECT trigger_id, workflow_id FROM workflow_trigger_bindings")
    .all() as any[];
  return rows.map((row) => ({
    triggerId: row.trigger_id,
    workflowId: row.workflow_id,
  }));
}

export function listWorkflowTriggerIdsForWorkflow(workflowId: string): string[] {
  const rows = getDb()
    .prepare(
      "SELECT trigger_id FROM workflow_trigger_bindings WHERE workflow_id = ?",
    )
    .all(workflowId) as { trigger_id: string }[];
  return rows.map((row) => row.trigger_id);
}

/** 绑定到某个触发器的工作流 id（调度器触发时使用） */
export function listWorkflowIdsForTrigger(triggerId: string): string[] {
  const rows = getDb()
    .prepare(
      "SELECT workflow_id FROM workflow_trigger_bindings WHERE trigger_id = ?",
    )
    .all(triggerId) as { workflow_id: string }[];
  return rows.map((row) => row.workflow_id);
}

/** 用给定集合整体替换某个工作流的触发器绑定 */
export function setWorkflowTriggers(
  workflowId: string,
  triggerIds: string[],
): void {
  const unique = [...new Set(triggerIds)];
  getDb().transaction(() => {
    prepare(
      "DELETE FROM workflow_trigger_bindings WHERE workflow_id = ?",
    ).run(workflowId);
    const insert = prepare(
      "INSERT OR IGNORE INTO workflow_trigger_bindings (trigger_id, workflow_id) VALUES (?, ?)",
    );
    for (const triggerId of unique) {
      // 只接受真实存在的触发器，避免渲染层传入过期 id 造成孤儿绑定
      if (!getWorkflowTrigger(triggerId)) continue;
      insert.run(triggerId, workflowId);
    }
  })();
}

