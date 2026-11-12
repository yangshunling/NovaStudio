/**
 * 工作流操作（SQLite repository）
 *
 * 只包含该领域的 SQL 与行映射；连接与语句缓存见 ../connection。
 */

import { randomUUID } from "crypto";
import { getDb, prepare } from "../connection";
import type { Workflow, WorkflowDraft, WorkflowGraph, WorkflowNode } from "../../../shared/types";
import { clamp } from "../../../shared/math";

// ============================================================================
// 工作流操作
// ============================================================================

/**
 * 单节点归一化：兜住手工编辑或损坏的 graph_json，
 * 策略 / 门禁字段缺失时补默认值（失败停止 + 自动通过）。
 */
function normalizeWorkflowNode(raw: any, index: number): WorkflowNode {
  const config = raw?.config ?? {};
  const type: WorkflowNode["type"] =
    raw?.type === "start" || raw?.type === "end" ? raw.type : "employee";
  const failureStrategy: WorkflowNode["config"]["failureStrategy"] =
    config.failureStrategy === "skip" || config.failureStrategy === "retry"
      ? config.failureStrategy
      : "stop";
  const px = Number(raw?.position?.x);
  const py = Number(raw?.position?.y);

  return {
    id: typeof raw?.id === "string" ? raw.id : `n_${index}`,
    type,
    name: typeof raw?.name === "string" ? raw.name : `节点 ${index + 1}`,
    position: {
      x: Number.isFinite(px) ? px : 120 + (index % 3) * 300,
      y: Number.isFinite(py) ? py : 140 + Math.floor(index / 3) * 160,
    },
    config: {
      employeeId:
        typeof config.employeeId === "string" ? config.employeeId : null,
      taskDetail:
        typeof config.taskDetail === "string"
          ? config.taskDetail
          : typeof config.prompt === "string"
            ? config.prompt
            : "",
      failureStrategy,
      maxRetries:
        typeof config.maxRetries === "number" && config.maxRetries > 0
          ? Math.min(5, Math.round(config.maxRetries))
          : 1,
      maxRevisions:
        typeof config.maxRevisions === "number"
          ? clamp(Math.round(config.maxRevisions), 0, 3)
          : 1,
      reviewMode: config.reviewMode === "manual" ? "manual" : "auto",
    },
  };
}

/** graph_json 的安全解析：结构损坏时退回空画布，不阻断列表加载 */
export function parseWorkflowGraph(raw: string): WorkflowGraph {
  try {
    const value = JSON.parse(raw);
    const rawNodes = Array.isArray(value?.nodes) ? value.nodes : [];
    const rawEdges = Array.isArray(value?.edges) ? value.edges : [];

    return {
      nodes: rawNodes.map(normalizeWorkflowNode),
      edges: rawEdges
        .filter(
          (edge: any) =>
            typeof edge?.source === "string" &&
            typeof edge?.target === "string",
        )
        .map((edge: any, index: number) => ({
          id: typeof edge.id === "string" ? edge.id : `e_${index}`,
          source: edge.source,
          target: edge.target,
        })),
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

function rowToWorkflow(row: any): Workflow {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? "",
    name: row.name,
    description: row.description ?? "",
    graph: parseWorkflowGraph(row.graph_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWorkflows(): Workflow[] {
  const rows = getDb()
    .prepare("SELECT * FROM workflows ORDER BY updated_at DESC")
    .all() as any[];
  return rows.map(rowToWorkflow);
}

export function getWorkflow(id: string): Workflow | null {
  const row = prepare("SELECT * FROM workflows WHERE id = ?").get(id) as any;
  return row ? rowToWorkflow(row) : null;
}

export function createWorkflow(draft: WorkflowDraft): Workflow {
  const id = randomUUID();
  const now = Date.now();
  prepare(
    "INSERT INTO workflows (id, workspace_id, name, description, graph_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    draft.workspaceId,
    draft.name,
    draft.description,
    JSON.stringify(draft.graph),
    now,
    now,
  );
  return getWorkflow(id)!;
}

export function updateWorkflow(id: string, draft: WorkflowDraft): Workflow | null {
  const info = getDb()
    .prepare(
      "UPDATE workflows SET workspace_id = ?, name = ?, description = ?, graph_json = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      draft.workspaceId,
      draft.name,
      draft.description,
      JSON.stringify(draft.graph),
      Date.now(),
      id,
    );
  return info.changes > 0 ? getWorkflow(id) : null;
}

export function listWorkflowsByWorkspace(workspaceId: string): Workflow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM workflows WHERE workspace_id = ? ORDER BY updated_at DESC",
    )
    .all(workspaceId) as any[];
  return rows.map(rowToWorkflow);
}

export function deleteWorkflow(id: string): void {
  getDb().transaction(() => {
    prepare("DELETE FROM workflow_trigger_bindings WHERE workflow_id = ?").run(
      id,
    );
    prepare("DELETE FROM workflows WHERE id = ?").run(id);
  })();
}

