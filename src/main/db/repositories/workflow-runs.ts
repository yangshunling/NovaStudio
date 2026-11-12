/**
 * 工作流运行（SQLite repository）
 *
 * 只包含该领域的 SQL 与行映射；连接与语句缓存见 ../connection。
 */

import { getDb, prepare } from "../connection";
import type { WorkflowGraph, WorkflowNode, WorkflowNodeAttemptKind, WorkflowNodeRun, WorkflowNodeRunStatus, WorkflowRun, WorkflowRunEvent, WorkflowRunEventType, WorkflowRunStatus } from "../../../shared/types";
import { parseWorkflowGraph } from "./workflows";

/**
 * 删除某工作流的所有运行记录，并返回需要一并清理的目录与会话。
 *
 * 事件 / 节点运行 / 运行主记录在一个事务里删除；
 * 会话与磁盘目录由调用方清理（需要 provider 与文件系统参与）。
 */
export function deleteWorkflowRuns(workflowId: string): {
  runIds: string[];
  sessionIds: string[];
} {
  const runRows = getDb()
    .prepare("SELECT id FROM workflow_runs WHERE workflow_id = ?")
    .all(workflowId) as { id: string }[];
  const runIds = runRows.map((row) => row.id);
  const sessionIds = new Set<string>();

  getDb().transaction(() => {
    for (const runId of runIds) {
      const nodeRows = getDb()
        .prepare("SELECT session_id FROM workflow_node_runs WHERE run_id = ?")
        .all(runId) as { session_id: string | null }[];
      const attemptRows = getDb()
        .prepare("SELECT session_id FROM workflow_node_attempts WHERE run_id = ?")
        .all(runId) as { session_id: string | null }[];
      for (const row of [...nodeRows, ...attemptRows]) {
        if (row.session_id) sessionIds.add(row.session_id);
      }
      prepare("DELETE FROM workflow_run_events WHERE run_id = ?").run(runId);
      prepare("DELETE FROM workflow_node_attempts WHERE run_id = ?").run(runId);
      prepare("DELETE FROM workflow_node_runs WHERE run_id = ?").run(runId);
      prepare("DELETE FROM workflow_runs WHERE id = ?").run(runId);
    }
  })();

  return { runIds, sessionIds: [...sessionIds] };
}

/**
 * 删除单次运行及其节点记录 / 事件；返回会话与运行记录，供调用方清理磁盘。
 */
export function deleteWorkflowRun(runId: string): {
  run: WorkflowRun | null;
  sessionIds: string[];
} {
  const run = getWorkflowRun(runId);
  if (!run) return { run: null, sessionIds: [] };

  const sessionIds = new Set<string>();
  const nodeRows = getDb()
    .prepare("SELECT session_id FROM workflow_node_runs WHERE run_id = ?")
    .all(runId) as { session_id: string | null }[];
  const attemptRows = getDb()
    .prepare("SELECT session_id FROM workflow_node_attempts WHERE run_id = ?")
    .all(runId) as { session_id: string | null }[];
  for (const row of [...nodeRows, ...attemptRows]) {
    if (row.session_id) sessionIds.add(row.session_id);
  }

  getDb().transaction(() => {
    prepare("DELETE FROM workflow_run_events WHERE run_id = ?").run(runId);
    prepare("DELETE FROM workflow_node_attempts WHERE run_id = ?").run(runId);
    prepare("DELETE FROM workflow_node_runs WHERE run_id = ?").run(runId);
    prepare("DELETE FROM workflow_runs WHERE id = ?").run(runId);
  })();

  return { run, sessionIds: [...sessionIds] };
}

// ============================================================================
// 工作流运行
// ============================================================================

function rowToWorkflowRun(row: any): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workspaceId: row.workspace_id,
    workflowName: row.workflow_name,
    workspacePath: row.workspace_path,
    graph: parseWorkflowGraph(row.graph_json),
    artifactDir: row.artifact_dir,
    status: row.status as WorkflowRunStatus,
    source: (row.source ?? "manual") as WorkflowRun["source"],
    triggerId: row.trigger_id ?? null,
    error: row.error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

function rowToWorkflowNodeRun(row: any): WorkflowNodeRun {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    nodeName: row.node_name,
    nodeType: row.node_type,
    employeeId: row.employee_id ?? null,
    employeeName: row.employee_name ?? null,
    agentId: row.agent_id ?? null,
    status: row.status as WorkflowNodeRunStatus,
    attempt: row.attempt ?? 1,
    round: row.round ?? 1,
    maxRetries: row.max_retries ?? 0,
    sessionId: row.session_id ?? null,
    artifactDir: row.artifact_dir ?? null,
    inputPath: row.input_path ?? null,
    outputPath: row.output_path ?? null,
    outputSummary: row.output_summary ?? null,
    error: row.error ?? null,
    decision: row.decision ?? null,
    decisionNote: row.decision_note ?? null,
    decidedAt: row.decided_at ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

export function createWorkflowRun(input: {
  id: string;
  workflowId: string;
  workspaceId: string;
  workflowName: string;
  workspacePath: string;
  graph: WorkflowGraph;
  artifactDir: string;
  status: WorkflowRunStatus;
  source?: WorkflowRun["source"];
  triggerId?: string | null;
  createdAt: number;
}): WorkflowRun {
  prepare(
    `INSERT INTO workflow_runs (
      id, workflow_id, workspace_id, workflow_name, workspace_path,
      graph_json, artifact_dir, status, source, trigger_id, error,
      created_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
  ).run(
    input.id,
    input.workflowId,
    input.workspaceId,
    input.workflowName,
    input.workspacePath,
    JSON.stringify(input.graph),
    input.artifactDir,
    input.status,
    input.source ?? "manual",
    input.triggerId ?? null,
    input.createdAt,
  );
  return getWorkflowRun(input.id)!;
}

export function getWorkflowRun(id: string): WorkflowRun | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_runs WHERE id = ?")
    .get(id) as any;
  return row ? rowToWorkflowRun(row) : null;
}

/**
 * 列表查询只投影摘要字段。
 *
 * graph_json 可能很大，而运行列表 / 侧栏 / 历史页只用状态与时间；
 * 详情页走 getWorkflowRun 再解析完整图。
 */
const RUN_SUMMARY_COLUMNS =
  "id, workflow_id, workspace_id, workflow_name, workspace_path, artifact_dir, status, source, trigger_id, error, created_at, started_at, finished_at";

function rowToWorkflowRunSummary(row: any): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workspaceId: row.workspace_id,
    workflowName: row.workflow_name,
    workspacePath: row.workspace_path,
    graph: { nodes: [], edges: [] },
    artifactDir: row.artifact_dir,
    status: row.status as WorkflowRunStatus,
    source: (row.source ?? "manual") as WorkflowRun["source"],
    triggerId: row.trigger_id ?? null,
    error: row.error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

export function listWorkflowRuns(workflowId?: string): WorkflowRun[] {
  const rows = workflowId
    ? (getDb()
        .prepare(
          `SELECT ${RUN_SUMMARY_COLUMNS} FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC`,
        )
        .all(workflowId) as any[])
    : (getDb()
        .prepare(
          `SELECT ${RUN_SUMMARY_COLUMNS} FROM workflow_runs ORDER BY created_at DESC`,
        )
        .all() as any[]);
  return rows.map(rowToWorkflowRunSummary);
}

export function listWorkflowRunsByWorkspace(
  workspaceId: string,
): WorkflowRun[] {
  const rows = getDb()
    .prepare(
      `SELECT ${RUN_SUMMARY_COLUMNS} FROM workflow_runs WHERE workspace_id = ? ORDER BY created_at DESC`,
    )
    .all(workspaceId) as any[];
  return rows.map(rowToWorkflowRunSummary);
}

/** 全局活跃运行：侧栏徽标、待审核提醒使用（不含已结束的运行） */
export function listActiveWorkflowRuns(): WorkflowRun[] {
  const rows = getDb()
    .prepare(
      `SELECT ${RUN_SUMMARY_COLUMNS} FROM workflow_runs WHERE status IN ('running','awaiting_approval') ORDER BY created_at ASC`,
    )
    .all() as any[];
  return rows.map(rowToWorkflowRunSummary);
}

export function updateWorkflowRun(
  id: string,
  patch: {
    status?: WorkflowRunStatus;
    error?: string | null;
    startedAt?: number | null;
    finishedAt?: number | null;
  },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(patch.status);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    values.push(patch.error);
  }
  if (patch.startedAt !== undefined) {
    sets.push("started_at = ?");
    values.push(patch.startedAt);
  }
  if (patch.finishedAt !== undefined) {
    sets.push("finished_at = ?");
    values.push(patch.finishedAt);
  }
  if (sets.length === 0) return;
  values.push(id);
  prepare(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`).run(
    ...values,
  );
}

export function createWorkflowNodeRun(input: {
  id: string;
  runId: string;
  nodeId: string;
  nodeName: string;
  nodeType: WorkflowNode["type"];
  employeeId: string | null;
  employeeName: string | null;
  agentId: string | null;
  status: WorkflowNodeRunStatus;
  attempt: number;
  maxRetries: number;
}): WorkflowNodeRun {
  prepare(
    `INSERT INTO workflow_node_runs (
      id, run_id, node_id, node_name, node_type, employee_id, employee_name,
      agent_id, status, attempt, max_retries
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.runId,
    input.nodeId,
    input.nodeName,
    input.nodeType,
    input.employeeId,
    input.employeeName,
    input.agentId,
    input.status,
    input.attempt,
    input.maxRetries,
  );
  return getWorkflowNodeRun(input.id)!;
}

/**
 * 记录一次节点调用（一轮执行 / 重试 / 修改）的会话与产物目录。
 *
 * workflow_node_runs.session_id 只保存最新一轮，历次调用的会话靠这张表保留引用：
 * - 删除工作流时才能把全部会话清理掉；
 * - 同一 attempt 的 revise 轮次共用 sessionId，靠 round / kind 区分。
 */
export function createWorkflowNodeAttempt(input: {
  id: string;
  runId: string;
  nodeRunId: string;
  attempt: number;
  round: number;
  kind: WorkflowNodeAttemptKind;
  sessionId: string | null;
  artifactDir: string | null;
}): void {
  prepare(
    `INSERT INTO workflow_node_attempts (
      id, run_id, node_run_id, attempt, round, kind,
      session_id, artifact_dir, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.runId,
    input.nodeRunId,
    input.attempt,
    input.round,
    input.kind,
    input.sessionId,
    input.artifactDir,
    Date.now(),
  );
}

/** 本轮运行结束后回填消息边界，运行详情据此切分每次调用产生的对话 */
export function updateWorkflowNodeAttemptMessages(
  id: string,
  patch: { userMessageId?: string | null; assistantMessageId?: string | null },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.userMessageId !== undefined) {
    sets.push("user_message_id = ?");
    values.push(patch.userMessageId);
  }
  if (patch.assistantMessageId !== undefined) {
    sets.push("assistant_message_id = ?");
    values.push(patch.assistantMessageId);
  }
  if (sets.length === 0) return;
  values.push(id);
  prepare(
    `UPDATE workflow_node_attempts SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...values);
}

/** 某节点的全部调用（按尝试 / 轮次升序）；运行详情用它还原完整对话 */
export function listWorkflowNodeAttempts(nodeRunId: string): Array<{
  attempt: number;
  round: number;
  kind: WorkflowNodeAttemptKind;
  sessionId: string | null;
  artifactDir: string | null;
  userMessageId: string | null;
  assistantMessageId: string | null;
}> {
  const rows = getDb()
    .prepare(
      "SELECT attempt, round, kind, session_id, artifact_dir, user_message_id, assistant_message_id FROM workflow_node_attempts WHERE node_run_id = ? ORDER BY attempt ASC, round ASC, rowid ASC",
    )
    .all(nodeRunId) as any[];
  return rows.map((row) => ({
    attempt: row.attempt,
    round: row.round ?? 1,
    kind: (row.kind ?? "initial") as WorkflowNodeAttemptKind,
    sessionId: row.session_id ?? null,
    artifactDir: row.artifact_dir ?? null,
    userMessageId: row.user_message_id ?? null,
    assistantMessageId: row.assistant_message_id ?? null,
  }));
}

export function getWorkflowNodeRun(id: string): WorkflowNodeRun | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_node_runs WHERE id = ?")
    .get(id) as any;
  return row ? rowToWorkflowNodeRun(row) : null;
}

export function listWorkflowNodeRuns(runId: string): WorkflowNodeRun[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM workflow_node_runs WHERE run_id = ? ORDER BY rowid ASC",
    )
    .all(runId) as any[];
  return rows.map(rowToWorkflowNodeRun);
}

const NODE_RUN_COLUMNS: Record<string, string> = {
  status: "status",
  attempt: "attempt",
  round: "round",
  sessionId: "session_id",
  artifactDir: "artifact_dir",
  inputPath: "input_path",
  outputPath: "output_path",
  outputSummary: "output_summary",
  error: "error",
  decision: "decision",
  decisionNote: "decision_note",
  decidedAt: "decided_at",
  startedAt: "started_at",
  finishedAt: "finished_at",
};

export function updateWorkflowNodeRun(
  id: string,
  patch: Partial<
    Pick<
      WorkflowNodeRun,
      | "status"
      | "attempt"
      | "round"
      | "sessionId"
      | "artifactDir"
      | "inputPath"
      | "outputPath"
      | "outputSummary"
      | "error"
      | "decision"
      | "decisionNote"
      | "decidedAt"
      | "startedAt"
      | "finishedAt"
    >
  >,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(NODE_RUN_COLUMNS)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (sets.length === 0) return;
  values.push(id);
  prepare(
    `UPDATE workflow_node_runs SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...values);
}

/**
 * 节点运行提示：把事件表里对用户有意义的告警 / 重试 / 审批取出来。
 * 只取最近 200 条，避免长运行把详情页撑爆。
 */
export function listWorkflowNodeNotices(nodeRunId: string): Array<{
  type: string;
  level: string;
  message: string;
  createdAt: number;
}> {
  const rows = getDb()
    .prepare(
      "SELECT type, payload_json, created_at FROM workflow_run_events WHERE node_run_id = ? AND type IN ('log','node_retry','approval_decided') ORDER BY seq ASC LIMIT 200",
    )
    .all(nodeRunId) as any[];

  const notices: Array<{
    type: string;
    level: string;
    message: string;
    createdAt: number;
  }> = [];

  for (const row of rows) {
    let payload: any = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    let message = "";
    let level = String(payload.level ?? "info");
    if (row.type === "log") {
      message = String(payload.message ?? "");
    } else if (row.type === "node_retry") {
      message = `第 ${payload.attempt ?? "?"} 次执行失败：${
        payload.error ?? "未知错误"
      }，准备第 ${Number(payload.attempt ?? 0) + 1} 次尝试`;
      level = "warning";
    } else if (row.type === "approval_decided") {
      const roundLabel = payload.round ? `第 ${payload.round} 轮` : "";
      if (payload.decision === "revise") {
        message = `人工审核要求修改${roundLabel ? `（${roundLabel}）` : ""}${payload.note ? `：${payload.note}` : ""}`;
        level = "info";
      } else if (payload.decision === "approve") {
        message = `人工审核通过${payload.note ? `：${payload.note}` : ""}`;
        level = "info";
      } else {
        message = `人工审核驳回${payload.note ? `：${payload.note}` : ""}`;
        level = "warning";
      }
    }
    if (message) {
      notices.push({
        type: row.type,
        level,
        message,
        createdAt: row.created_at,
      });
    }
  }
  return notices;
}

export function appendWorkflowRunEvent(input: {
  runId: string;
  nodeRunId: string | null;
  type: WorkflowRunEventType;
  payload: Record<string, unknown>;
}): WorkflowRunEvent {
  const info = getDb()
    .prepare(
      "INSERT INTO workflow_run_events (run_id, node_run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      input.runId,
      input.nodeRunId,
      input.type,
      JSON.stringify(input.payload),
      Date.now(),
    );
  const seq = Number(info.lastInsertRowid);
  return {
    seq,
    runId: input.runId,
    nodeRunId: input.nodeRunId,
    type: input.type,
    payload: input.payload,
    createdAt: Date.now(),
  };
}

/** 标记应用退出时仍处于活动状态的运行为中断（进程已不存在，不能假装还在跑） */
export function interruptStaleWorkflowRuns(): void {
  const now = Date.now();

  // 触发器启动的运行被异常中断时，也把原因回写到触发器卡片
  const staleTriggerIds = getDb()
    .prepare(
      "SELECT DISTINCT trigger_id FROM workflow_runs WHERE status IN ('running','awaiting_approval') AND source = 'trigger' AND trigger_id IS NOT NULL",
    )
    .all() as { trigger_id: string }[];
  for (const row of staleTriggerIds) {
    prepare(
      "UPDATE workflow_triggers SET last_error = ?, updated_at = ? WHERE id = ?",
    ).run("应用异常退出，运行被中断", now, row.trigger_id);
  }

  prepare(
    "UPDATE workflow_runs SET status = 'interrupted', error = '应用已退出，运行被中断', finished_at = ? WHERE status IN ('running','awaiting_approval')",
  ).run(now);
  prepare(
    "UPDATE workflow_node_runs SET status = 'canceled', finished_at = ? WHERE status IN ('pending','running','awaiting_approval','retrying')",
  ).run(now);
}

