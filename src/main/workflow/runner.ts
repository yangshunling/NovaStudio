/**
 * 工作流运行引擎（P0）
 *
 * 模型：工作流是编排器，每个节点是一次独立的数字员工执行。
 * - DAG 调度：节点在前置节点全部进入终态后启动，独立分支并行执行
 *   （并发上限 MAX_PARALLEL_NODES，汇合语义为 AND）
 * - 每节点独立会话；上下文只通过上游节点的输出摘要传递
 * - Claude 节点使用独立 CLAUDE_CONFIG_DIR，MCP 走独立配置文件
 *
 * 运行状态全部落库，事件同时推送渲染层；渲染层断线后可重新拉取回放。
 */

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { rm, rmdir } from "fs/promises";
import { dirname, join } from "path";
import { getProvider, listProviders } from "../agents/registry";
import type { AgentInvocationInfo, PreparedAgentRun } from "../agents/types";
import type { AgentService, RunOutcome } from "../agents/agent-service";
import * as db from "../db/sqlite";
import {
  DEFAULT_SETTINGS,
  type AgentEvent,
  type DigitalEmployee,
  type SessionOptions,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeAttemptKind,
  type WorkflowNodeRun,
  type WorkflowNodeRunStatus,
  type WorkflowRun,
  type WorkflowRunEvent,
  type WorkflowRunEventType,
  type WorkflowRunSource,
  type WorkflowRunStatus,
} from "../../shared/types";
import {
  createRunArtifactDir,
  ensureArtifactsRoot,
  ensureDir,
  nodeArtifactDir,
  truncate,
  writeJson,
  writeText,
} from "./artifacts";
import { GraphValidationError, validateGraph } from "./graph";
import {
  buildExecutionReport,
  type ExecutionReportKnowledgeBase,
} from "./execution-report";
import { resolveEmployeeKnowledge } from "../knowledge/runtime";

/** 单节点输出交给下游时的摘要上限 */
const UPSTREAM_SUMMARY_LIMIT = 4000;
/** 重试等待基数：第 N 次重试等待 N × 2s */
const RETRY_BASE_MS = 2000;
/** 单个节点尝试保留的实时事件上限：超出后只继续推增量，不再占用内存 */
const LIVE_EVENT_LIMIT = 20_000;

/** 同一工作流内并行执行的节点数上限。每个节点都是一个独立的 Agent 进程。 */
const MAX_PARALLEL_NODES = 3;

/**
 * 人工审核最长等待时间。
 * 超时只是「没人确认」，不是「人工驳回」：运行按中断收尾并保留产物，
 * 用户回来后可以继续执行；否则一个被遗忘的审批会把工作区永久锁住。
 */
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 节点实际生效的自动重试次数。
 * 数据可能来自旧版本或外部导入，不能信任 UI 的 1-5 限制。
 */
function effectiveMaxRetries(node: WorkflowNode): number {
  if (node.config.failureStrategy !== "retry") return 0;
  const raw = Number(node.config.maxRetries);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(5, Math.max(1, Math.round(raw)));
}

/**
 * 人工审核允许的「要求修改」轮数。
 * 旧数据没有该字段时默认 1 轮；范围 0-3，0 表示只能通过 / 驳回。
 */
function effectiveMaxRevisions(node: WorkflowNode): number {
  const raw = Number(node.config.maxRevisions);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(3, Math.max(0, Math.round(raw)));
}

class CanceledError extends Error {
  constructor() {
    super("运行已取消");
    this.name = "CanceledError";
  }
}

/**
 * 等待人工审核超时。
 *
 * 必须与 CanceledError / 普通失败区分开：运行应记为 interrupted（可续跑），
 * 而不是写成「人工驳回」——那会让 resume 永久拒绝这条运行。
 */
class ApprovalTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalTimeoutError";
  }
}

/**
 * 工作区已被占用。
 *
 * 用类型而不是错误文案判断：触发器调度器依赖这个语义决定是否排队重试，
 * 文案随时可能调整，类型不会。
 */
export class WorkspaceBusyError extends Error {
  constructor() {
    super("该工作区已有运行中的工作流，请等待它结束");
    this.name = "WorkspaceBusyError";
  }
}

interface ApprovalDecision {
  /**
   * - approve / reject：最终决定
   * - revise：要求修改，复用当前会话再执行一轮
   * - cancel：运行被终止
   * - timeout：等待超时，既不是通过也不是人工驳回
   */
  action: "approve" | "reject" | "revise" | "cancel" | "timeout";
  note: string;
}

interface ActiveRun {
  id: string;
  workflow: Workflow;
  workspaceId: string;
  workspacePath: string;
  runDir: string;
  /** 完整计划顺序：用于产物目录编号与画布展示 */
  order: WorkflowNode[];
  /** 本次实际要执行的节点（续跑时是失败节点及其下游） */
  executionOrder: WorkflowNode[];
  /** 续跑时，已在上一次执行中完成、本次直接视为 done 的节点 */
  seededDone: Set<string>;
  predecessors: Map<string, string[]>;
  employees: Map<string, DigitalEmployee>;
  /** nodeId → 本次运行的节点执行记录 */
  nodeRuns: Map<string, WorkflowNodeRun>;
  canceled: boolean;
  /** 失败停止：阻止尚未创建会话的节点继续启动 */
  stopping: boolean;
  /** 当前正在运行的节点会话；并行执行时可能有多个 */
  sessions: Set<string>;
  approvals: Map<
    string,
    { resolve: (decision: ApprovalDecision) => void; timer: NodeJS.Timeout }
  >;
  /**
   * nodeRunId → 本次尝试的原始事件（不落库）。
   * 运行记录中途打开时用它回放已产生的对话，之后的增量走推送。
   */
  live: Map<
    string,
    { attempt: number; round: number; seq: number; events: AgentEvent[] }
  >;
}

export interface WorkflowRunner {
  /** 启动前会先做 Agent 安装 / 连接配置校验，因此是异步的 */
  start(
    workflowId: string,
    options?: { source?: WorkflowRunSource; triggerId?: string | null },
  ): Promise<WorkflowRun>;
  /**
   * 从失败节点（或其下游）继续执行同一个运行。
   * 未指定 nodeRunId 时自动选择第一个失败 / 已取消的节点。
   */
  resume(runId: string, nodeRunId?: string): Promise<WorkflowRun>;
  cancel(runId: string): boolean;
  approve(
    runId: string,
    nodeRunId: string,
    action: "approve" | "reject" | "revise",
    note?: string,
  ): boolean;
  /** 删除工作流 / 工作区前检查是否有活跃运行 */
  hasActiveRunForWorkflow(workflowId: string): boolean;
  hasActiveRunInWorkspace(workspaceId: string): boolean;
  /** 运行中节点的实时事件快照；节点不在运行时返回 null */
  liveTranscript(
    runId: string,
    nodeRunId: string,
  ): { attempt: number; round: number; seq: number; events: AgentEvent[] } | null;
  shutdown(): void;
}

export interface WorkflowRunnerDeps {
  service: AgentService;
  emit: (event: WorkflowRunEvent) => void;
  /**
   * 节点执行中的实时事件。
   * 只推送、不落库：事件量按 token 计，落库会把运行事件表撑爆；
   * 运行结束后以 messages 表里的完整消息为准。
   */
  emitAgentEvent: (payload: {
    runId: string;
    nodeRunId: string;
    attempt: number;
    round: number;
    seq: number;
    event: AgentEvent;
  }) => void;
  userDataDir: string;
  /**
   * 冲掉推送层缓冲区里尚未发送的流式事件。
   *
   * 节点 token 走批量聚合（16ms 一批），而运行状态事件（run_finished 等）
   * 是立即发送的。收尾前不冲缓冲，渲染层可能先收到「已完成」再收到最后一批 token。
   */
  flushEvents?: () => void;
  /**
   * 运行收尾回调（成功 / 失败 / 中断）。
   * 触发器调度器用它把运行结果回写到触发器，避免只看到“已触发”却不知道结果。
   */
  onRunFinished?: (run: WorkflowRun) => void;
}

export function createWorkflowRunner(deps: WorkflowRunnerDeps): WorkflowRunner {
  const activeRuns = new Map<string, ActiveRun>();
  /**
   * 已通过占位检查、但仍在异步校验（Agent 安装检测）中的运行。
   *
   * start() 里 await 之后才把 activeRuns 写好，这中间存在竞争窗口：
   * 两次 start 都能看到“工作区空闲”。reservations 让占位与检查在同一帧完成。
   */
  const reservations = new Map<
    string,
    { workspaceId: string; workflowId: string }
  >();

  function workspaceBusy(workspaceId: string): boolean {
    return (
      [...activeRuns.values()].some((run) => run.workspaceId === workspaceId) ||
      [...reservations.values()].some((run) => run.workspaceId === workspaceId)
    );
  }

  function workflowBusy(workflowId: string): boolean {
    return (
      [...activeRuns.values()].some((run) => run.workflow.id === workflowId) ||
      [...reservations.values()].some((run) => run.workflowId === workflowId)
    );
  }

  function emitEvent(
    runId: string,
    nodeRunId: string | null,
    type: WorkflowRunEventType,
    payload: Record<string, unknown> = {},
  ): void {
    /*
     * 状态事件（node_finished / run_finished 等）立即发送，而节点 token
     * 走 16ms 批量聚合。先冲掉缓冲，否则渲染层会先看到“节点已完成”，
     * 再收到最后一批 token。
     */
    deps.flushEvents?.();
    const event = db.appendWorkflowRunEvent({ runId, nodeRunId, type, payload });
    deps.emit(event);
  }

  function updateStatus(
    nodeRunId: string,
    status: WorkflowNodeRunStatus,
    extra: Parameters<typeof db.updateWorkflowNodeRun>[1] = {},
  ): void {
    db.updateWorkflowNodeRun(nodeRunId, { status, ...extra });
  }

  function nodeRunOf(active: ActiveRun, nodeId: string): WorkflowNodeRun {
    const current = db.getWorkflowNodeRun(active.nodeRuns.get(nodeId)!.id);
    if (!current) throw new Error(`节点执行记录不存在：${nodeId}`);
    active.nodeRuns.set(nodeId, current);
    return current;
  }

  // ==========================================================================
  // 启动
  // ==========================================================================

  async function start(
    workflowId: string,
    options: { source?: WorkflowRunSource; triggerId?: string | null } = {},
  ): Promise<WorkflowRun> {
    const workflow = db.getWorkflow(workflowId);
    if (!workflow) throw new Error("工作流不存在");

    const workspace = db.getProject(workflow.workspaceId);
    if (!workspace) {
      throw new Error("工作流未指定工作区，请先在编辑器中选一个工作区");
    }
    if (!workspace.cwd || !existsSync(workspace.cwd)) {
      throw new Error(`工作区目录不存在：${workspace.cwd || "（空）"}`);
    }
    if (workspaceBusy(workspace.id)) throw new WorkspaceBusyError();

    const runId = randomUUID();
    // 同步占位：后面的 await 期间，同工作区的第二次 start 会立即被拒绝
    reservations.set(runId, {
      workspaceId: workspace.id,
      workflowId: workflow.id,
    });

    let runCreated = false;
    let activeAttached = false;
    try {
      // 先确认执行 Agent 已安装，再创建运行记录；
      // 否则用户会看到一条注定失败的运行记录，排查成本更高。
      await assertAgentReady();

      /*
       * 员工快照必须放在最后一个 await 之后：
       * 从这里到节点记录创建完成为止不再让出事件循环，
       * 校验过的员工就不可能在校验与写入之间被删除。
       */
      const employees = new Map(
        db.listDigitalEmployees().map((employee) => [employee.id, employee]),
      );

      let validated;
      try {
        validated = validateGraph(workflow.graph, employees);
      } catch (err) {
        if (err instanceof GraphValidationError) {
          throw new Error(err.issues.join("\n"));
        }
        throw err;
      }

      const runDir = createRunArtifactDir(workspace.cwd, workflow.id, runId);
      const now = Date.now();
      db.createWorkflowRun({
        id: runId,
        workflowId: workflow.id,
        workspaceId: workspace.id,
        workflowName: workflow.name,
        workspacePath: workspace.cwd,
        graph: workflow.graph,
        artifactDir: runDir,
        status: "running",
        source: options.source ?? "manual",
        triggerId: options.triggerId ?? null,
        createdAt: now,
      });
      runCreated = true;
      db.updateWorkflowRun(runId, { startedAt: now });

      for (const node of validated.order) {
        const employee = employees.get(node.config.employeeId ?? "");
        if (!employee) {
          throw new Error(`节点「${node.name}」绑定的数字员工已不存在`);
        }
        db.createWorkflowNodeRun({
          id: randomUUID(),
          runId,
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          employeeId: employee.id,
          employeeName: employee.name,
          agentId: resolveAgentId(),
          status: "pending",
          attempt: 1,
          maxRetries: effectiveMaxRetries(node),
        });
      }

      const active: ActiveRun = {
        id: runId,
        workflow,
        workspaceId: workspace.id,
        workspacePath: workspace.cwd,
        runDir,
        order: validated.order,
        executionOrder: validated.order,
        seededDone: new Set(),
        predecessors: validated.predecessors,
        employees,
        nodeRuns: new Map(
          db
            .listWorkflowNodeRuns(runId)
            .map((nodeRun) => [nodeRun.nodeId, nodeRun] as const),
        ),
        canceled: false,
        stopping: false,
        sessions: new Set(),
        approvals: new Map(),
        live: new Map(),
      };
      activeRuns.set(runId, active);
      activeAttached = true;

      emitEvent(runId, null, "run_started", {
        workflowId: workflow.id,
        workflowName: workflow.name,
        workspacePath: workspace.cwd,
        artifactDir: runDir,
        nodeCount: validated.order.length,
      });

      // 图校验的警告不阻断运行，但必须留下记录：分支串行、空任务详情等
      for (const message of validated.warnings) {
        emitEvent(runId, null, "log", {
          level: "warning",
          message,
          source: "graph",
        });
      }

      const run = db.getWorkflowRun(runId)!;

      void prepareRunFiles(active).then(() => execute(active)).catch((err) => {
        finish(active, "failed", messageOf(err));
      });

      return run;
    } catch (err) {
      // 运行记录已经创建、但启动流程失败：必须落一个终态，
      // 否则这条记录会永远停在“运行中”。
      if (activeAttached) activeRuns.delete(runId);
      if (runCreated) failStartupRun(runId, messageOf(err));
      throw err;
    } finally {
      reservations.delete(runId);
    }
  }

  /** 启动阶段失败后的收尾：运行记录置为失败，未执行的节点标记取消 */
  function failStartupRun(runId: string, error: string): void {
    try {
      const finishedAt = Date.now();
      db.updateWorkflowRun(runId, {
        status: "failed",
        error,
        finishedAt,
      });
      for (const nodeRun of db.listWorkflowNodeRuns(runId)) {
        if (nodeRun.status === "pending" || nodeRun.status === "running") {
          db.updateWorkflowNodeRun(nodeRun.id, {
            status: "canceled",
            finishedAt,
          });
        }
      }
      emitEvent(runId, null, "run_finished", { status: "failed", error });
      const finished = db.getWorkflowRun(runId);
      if (finished) deps.onRunFinished?.(finished);
    } catch {
      // 收尾失败（例如数据库已关闭）不能掩盖真正的启动错误
    }
  }

  /**
   * 节点执行使用的 Agent。
   *
   * 当前只有 Claude 一个 provider，节点不再单独选择 Agent。
   * 注册表按 manifest.order 排序，将来新增 provider 时这里需要恢复节点级选择。
   */
  function resolveAgentId(): string {
    const provider = listProviders()[0];
    if (!provider) {
      throw new Error("未注册任何 Agent，无法执行工作流节点");
    }
    return provider.manifest.id;
  }

  /**
   * 启动前置校验：执行 Agent 必须已安装。
   *
   * Nova 不再校验自己的连接配置——各 CLI 直接使用本机配置与登录。
   */
  async function assertAgentReady(): Promise<void> {
    const agentId = resolveAgentId();
    const provider = getProvider(agentId);
    if (!provider) {
      throw new Error(`Agent「${agentId}」不存在或未注册`);
    }
    const status = await provider.detect().catch(() => ({ installed: false }));
    if (!status.installed) {
      throw new Error(
        `Agent「${provider.manifest.displayName}」未安装或不可用。请先完成安装。`,
      );
    }
  }

  /**
   * 续跑：在同一个运行里，从指定节点（默认第一个失败节点）重新执行
   * 该节点及其全部下游。上游节点保留原有输出，下游直接复用。
   */
  async function resume(
    runId: string,
    nodeRunId?: string,
  ): Promise<WorkflowRun> {
    const run = db.getWorkflowRun(runId);
    if (!run) throw new Error("运行记录不存在");
    if (activeRuns.has(runId) || reservations.has(runId)) {
      throw new Error("该运行正在执行，请等待结束");
    }
    if (run.status === "running" || run.status === "awaiting_approval") {
      throw new Error("该运行正在执行，请等待结束");
    }

    const workflow = db.getWorkflow(run.workflowId);
    if (!workflow) throw new Error("工作流不存在");
    const workspace = db.getProject(run.workspaceId);
    if (!workspace?.cwd || !existsSync(workspace.cwd)) {
      throw new Error(`工作区目录不存在：${workspace?.cwd || "（空）"}`);
    }
    if (workspaceBusy(workspace.id)) throw new WorkspaceBusyError();

    const nodeRuns = db.listWorkflowNodeRuns(runId);
    // 人工审核驳回意味着产物本身不合格，重跑没有意义：整条运行就此终止
    const rejectedNode = nodeRuns.find((item) => item.decision === "rejected");
    if (rejectedNode) {
      throw new Error(
        `节点「${rejectedNode.nodeName}」已被人工驳回，该运行不能继续执行`,
      );
    }
    const target = nodeRunId
      ? nodeRuns.find((item) => item.id === nodeRunId)
      : (nodeRuns.find((item) => item.status === "failed") ??
        nodeRuns.find(
          (item) => item.status === "canceled" || item.status === "skipped",
        ));
    if (!target) throw new Error("找不到可续跑的节点");
    if (target.nodeType !== "employee") {
      throw new Error("只能从执行节点续跑");
    }

    reservations.set(runId, {
      workspaceId: workspace.id,
      workflowId: workflow.id,
    });

    let active: ActiveRun | null = null;
    try {
      await assertAgentReady();

      const employees = new Map(
        db.listDigitalEmployees().map((employee) => [employee.id, employee]),
      );
      const validated = validateGraph(run.graph, employees);

      // target 及其全部下游
      const outgoing = new Map<string, string[]>();
      for (const node of run.graph.nodes) outgoing.set(node.id, []);
      for (const edge of run.graph.edges) {
        outgoing.get(edge.source)?.push(edge.target);
      }
      const descendants = new Set<string>();
      const stack = [target.nodeId];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (descendants.has(id)) continue;
        descendants.add(id);
        for (const next of outgoing.get(id) ?? []) stack.push(next);
      }

      /*
       * 除了目标节点及其下游，还要把「没有成功完成的上游」补进执行集合。
       * 例如并行分支 A/B 汇合到 C，A 失败导致 B 被取消；从 A 续跑时，
       * B 也必须重跑，否则 C 会拿到一个 canceled 的上游。
       */
      const executionIds = new Set(descendants);
      const queue = [...descendants];
      const statusByNode = new Map(
        nodeRuns.map((item) => [item.nodeId, item.status] as const),
      );
      while (queue.length > 0) {
        const id = queue.shift()!;
        for (const predecessorId of validated.predecessors.get(id) ?? []) {
          if (executionIds.has(predecessorId)) continue;
          const status = statusByNode.get(predecessorId);
          if (status === "succeeded" || status === "skipped") continue;
          executionIds.add(predecessorId);
          queue.push(predecessorId);
        }
      }

      const executionOrder = validated.order.filter((node) =>
        executionIds.has(node.id),
      );
      if (executionOrder.length === 0) {
        throw new Error("该节点没有可执行的后续节点");
      }
      const seededDone = new Set(
        validated.order
          .filter((node) => !executionIds.has(node.id))
          .map((node) => node.id),
      );

      // 重置本次要执行的节点；历次尝试记录保留在 workflow_node_attempts
      for (const node of executionOrder) {
        const nodeRun = nodeRuns.find((item) => item.nodeId === node.id);
        if (!nodeRun) continue;
        const attempts = db.listWorkflowNodeAttempts(nodeRun.id);
        const nextAttempt =
          Math.max(0, ...attempts.map((attempt) => attempt.attempt)) + 1;
        db.updateWorkflowNodeRun(nodeRun.id, {
          status: "pending",
          attempt: nextAttempt,
          round: 1,
          sessionId: null,
          artifactDir: null,
          inputPath: null,
          outputPath: null,
          outputSummary: null,
          error: null,
          decision: null,
          decisionNote: null,
          decidedAt: null,
          startedAt: null,
          finishedAt: null,
        });
      }

      // 先取好节点快照，再切 run 状态：避免状态已变 running 但 active 未挂上
      const refreshedNodeRuns = new Map(
        db
          .listWorkflowNodeRuns(runId)
          .map((nodeRun) => [nodeRun.nodeId, nodeRun] as const),
      );

      db.updateWorkflowRun(runId, {
        status: "running",
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
      });

      active = {
        id: runId,
        workflow: { ...workflow, graph: run.graph },
        workspaceId: workspace.id,
        workspacePath: workspace.cwd,
        runDir: run.artifactDir,
        order: validated.order,
        executionOrder,
        seededDone,
        predecessors: validated.predecessors,
        employees,
        nodeRuns: refreshedNodeRuns,
        canceled: false,
        stopping: false,
        sessions: new Set(),
        approvals: new Map(),
        live: new Map(),
      };
      activeRuns.set(runId, active);

      emitEvent(runId, null, "run_started", {
        workflowId: workflow.id,
        workflowName: workflow.name,
        workspacePath: workspace.cwd,
        artifactDir: run.artifactDir,
        nodeCount: executionOrder.length,
        resumed: true,
        fromNodeId: target.nodeId,
        fromNodeName: target.nodeName,
      });
      for (const message of validated.warnings) {
        emitEvent(runId, null, "log", {
          level: "warning",
          message,
          source: "graph",
        });
      }

      void prepareRunFiles(active)
        .then(() => execute(active!))
        .catch((err) => finish(active!, "failed", messageOf(err)));

      return db.getWorkflowRun(runId)!;
    } catch (err) {
      if (active) finish(active, "failed", messageOf(err));
      throw err;
    } finally {
      reservations.delete(runId);
    }
  }

  async function prepareRunFiles(active: ActiveRun): Promise<void> {
    await ensureArtifactsRoot(active.workspacePath);
    await ensureDir(active.runDir);
    await writeJson(join(active.runDir, "run.json"), {
      id: active.id,
      workflowId: active.workflow.id,
      workflowName: active.workflow.name,
      workspacePath: active.workspacePath,
      startedAt: Date.now(),
      nodes: active.order.map((node) => ({
        id: node.id,
        name: node.name,
        employeeId: node.config.employeeId,
      })),
    });
  }

  // ==========================================================================
  // 主循环
  // ==========================================================================

  /** 终止本次运行中所有正在执行的节点会话 */
  function abortSessions(active: ActiveRun): void {
    for (const sessionId of active.sessions) {
      deps.service.abort(sessionId);
    }
  }

  /** 结束所有等待中的审批，让它们从 waitApproval 正常返回 */
  function cancelApprovals(active: ActiveRun): void {
    for (const entry of active.approvals.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ action: "cancel", note: "" });
    }
    active.approvals.clear();
  }

  /**
   * DAG 调度：节点在前置节点全部进入终态后启动，独立分支并行执行。
   *
   * - 汇合语义是 AND：所有直接前驱都完成后才执行；
   * - skipped 也算终态，下游继续执行（并在提示词里看到“已跳过”）；
   * - 失败策略 stop / retry 耗尽会终止整个运行，并中断其它并行节点；
   * - 并发上限 MAX_PARALLEL_NODES，避免一次拉起过多 Agent 进程。
   */
  async function execute(active: ActiveRun): Promise<void> {
    const done = new Set<string>(active.seededDone);
    const remaining = new Set(active.executionOrder.map((node) => node.id));
    const running = new Map<
      string,
      Promise<{
        node: WorkflowNode;
        outcome?:
          | "succeeded"
          | "skipped"
          | "failed"
          | "canceled"
          | "interrupted";
        error?: string;
      }>
    >();
    let failedError: string | null = null;
    /** 审核超时导致的中断原因：优先于普通失败展示 */
    let interruptedError: string | null = null;

    const launch = (node: WorkflowNode) => {
      /*
       * 注意：这里不要在 promise 的 finally 里把自己从 running 删除。
       * 两个并行节点可能在同一微任务批次完成；先完成的那个如果立刻摘掉，
       * 下一个 race 就看不到它的结果，remaining 还在，会导致重复启动。
       * 由主循环处理完结果后再删除。
       */
      const task = executeNode(active, node)
        .then((outcome) => ({ node, outcome }))
        .catch((err) => ({ node, error: messageOf(err) }));
      running.set(node.id, task);
    };

    try {
      while (remaining.size > 0 || running.size > 0) {
        if (active.canceled) break;

        if (!failedError) {
          for (const node of active.executionOrder) {
            if (running.size >= MAX_PARALLEL_NODES) break;
            if (!remaining.has(node.id) || running.has(node.id)) continue;
            const predecessors = active.predecessors.get(node.id) ?? [];
            if (!predecessors.every((id) => done.has(id))) continue;
            launch(node);
          }
        }

        if (running.size === 0) {
          if (failedError || active.canceled) break;
          // 还有节点没执行，但没有任何节点就绪：图 / 运行快照不一致
          failedError = "工作流调度无法继续：存在未满足的前置节点";
          break;
        }

        const settled = await Promise.race(running.values());
        running.delete(settled.node.id);
        if (settled.error) {
          if (active.canceled) break;
          failedError = settled.error;
          break;
        }

        const outcome = settled.outcome!;
        done.add(settled.node.id);
        remaining.delete(settled.node.id);

        if (outcome === "failed") {
          failedError = nodeFailureMessage(active, settled.node);
          break;
        }
        if (outcome === "interrupted") {
          /*
           * 人工审核超时：不是失败，运行按「中断」收尾并保留产物，
           * 用户回来审核后可以从这条运行继续。
           */
          interruptedError = nodeFailureMessage(active, settled.node);
          break;
        }
        if (outcome === "canceled") {
          // executeNode 目前用抛错表达取消；这里兜底，避免误判为成功
          if (!active.canceled) failedError = "节点执行被取消";
          break;
        }
      }
    } finally {
      /*
       * 失败停止 / 取消：终止其它并行节点并等它们收尾。
       * 否则 finish 把节点标记为 canceled 之后，它们还可能继续写库。
       */
      if (failedError || interruptedError || active.canceled) {
        active.stopping = true;
        // 等待审核的节点没有子进程，必须主动结束它的 Promise
        cancelApprovals(active);
        abortSessions(active);
        await Promise.allSettled([...running.values()]);
      }
    }

    if (active.canceled) {
      finish(active, "canceled");
      return;
    }
    if (interruptedError) {
      // 审核超时：产物已生成，保留为可续跑的中断态，而不是失败
      finish(active, "interrupted", interruptedError);
      return;
    }
    if (failedError) {
      finish(active, "failed", failedError);
      return;
    }
    finish(active, "succeeded");
  }

  async function executeNode(
    active: ActiveRun,
    node: WorkflowNode,
  ): Promise<"succeeded" | "skipped" | "failed" | "canceled" | "interrupted"> {
    const employee = active.employees.get(node.config.employeeId ?? "");
    if (!employee) throw new Error(`节点「${node.name}」没有可用数字员工`);

    const initial = nodeRunOf(active, node.id);
    updateStatus(initial.id, "running", {
      startedAt: Date.now(),
      error: null,
      round: 1,
    });
    emitEvent(active.id, initial.id, "node_status", {
      nodeId: node.id,
      nodeName: node.name,
      status: "running",
      round: 1,
    });

    const maxRetries = effectiveMaxRetries(node);
    let attempt = initial.attempt || 1;
    let lastError = "";

    while (true) {
      if (active.canceled || active.stopping) throw new CanceledError();

      if (!lastError) {
        // 重试时以本轮实际开始时间为准：否则 startedAt 会一直停在首轮，
        // 把等待重试的时间也算进节点耗时
        const attemptStartedAt = Date.now();
        updateStatus(initial.id, "running", {
          attempt,
          round: 1,
          startedAt: attemptStartedAt,
          finishedAt: null,
          error: null,
        });
        emitEvent(active.id, initial.id, "node_status", {
          nodeId: node.id,
          nodeName: node.name,
          status: "running",
          attempt,
          round: 1,
        });

        // 一次「执行尝试」包含初次执行与后续的人工要求修改；
        // 执行失败重试才会开新的 attempt / 新会话。
        const outcome = await runChain(active, node, employee, attempt);

        if (outcome.ok) {
          updateStatus(initial.id, "succeeded", {
            attempt,
            round: outcome.round,
            startedAt: attemptStartedAt,
            finishedAt: outcome.finishedAt,
            error: null,
            sessionId: outcome.sessionId,
            artifactDir: outcome.attemptDir,
            inputPath: outcome.inputPath,
            outputPath: outcome.outputPath,
            outputSummary: outcome.summary,
          });
          emitEvent(active.id, initial.id, "node_finished", {
            nodeId: node.id,
            nodeName: node.name,
            status: "succeeded",
            attempt,
            round: outcome.round,
            sessionId: outcome.sessionId,
            outputPath: outcome.outputPath,
          });
          return "succeeded";
        }

        if (outcome.interrupted) {
          /*
           * 没人来审核：按「中断」收尾，节点置为 canceled 而不是 failed。
           * 这样运行记录仍可续跑，用户回来确认后不会被迫从头重跑。
           */
          updateStatus(initial.id, "canceled", {
            attempt,
            round: outcome.round,
            finishedAt: outcome.finishedAt,
            error: outcome.error,
            sessionId: outcome.sessionId,
            artifactDir: outcome.attemptDir,
            inputPath: outcome.inputPath,
            outputPath: outcome.outputPath,
            outputSummary: outcome.summary,
          });
          emitEvent(active.id, initial.id, "node_finished", {
            nodeId: node.id,
            nodeName: node.name,
            status: "canceled",
            attempt,
            round: outcome.round,
            error: outcome.error,
          });
          return "interrupted";
        }

        if (outcome.rejected) {
          // 人工驳回 / 修改轮数耗尽：直接终止整条运行，不走失败重试策略
          updateStatus(initial.id, "failed", {
            attempt,
            round: outcome.round,
            finishedAt: outcome.finishedAt,
            error: outcome.error,
            sessionId: outcome.sessionId,
            artifactDir: outcome.attemptDir,
            inputPath: outcome.inputPath,
            outputPath: outcome.outputPath,
            outputSummary: outcome.summary,
          });
          emitEvent(active.id, initial.id, "node_finished", {
            nodeId: node.id,
            nodeName: node.name,
            status: "failed",
            attempt,
            round: outcome.round,
            error: outcome.error,
          });
          return "failed";
        }

        if (outcome.canceled) throw new CanceledError();
        lastError = outcome.error || "节点执行失败";
      }

      // ---- 失败处理 ----
      updateStatus(initial.id, "failed", {
        attempt,
        round: nodeRunOf(active, node.id).round,
        error: lastError,
      });

      // 执行失败按重试策略处理；人工驳回 / 修改耗尽在上面已直接终止
      if (attempt <= maxRetries) {
        updateStatus(initial.id, "retrying", {
          attempt,
          round: nodeRunOf(active, node.id).round,
          error: lastError,
        });
        emitEvent(active.id, initial.id, "node_retry", {
          nodeId: node.id,
          nodeName: node.name,
          attempt,
          round: nodeRunOf(active, node.id).round,
          maxRetries,
          error: lastError,
        });
        await delay(active, RETRY_BASE_MS * attempt);
        attempt += 1;
        // 必须清空上一轮错误，否则下一轮会跳过执行（只重试等待、不真正运行）
        lastError = "";
        db.updateWorkflowNodeRun(initial.id, { attempt, round: 1, error: null });
        continue;
      }

      const finishedAt = Date.now();
      if (node.config.failureStrategy === "skip") {
        updateStatus(initial.id, "skipped", {
          attempt,
          round: nodeRunOf(active, node.id).round,
          finishedAt,
          error: lastError,
        });
        emitEvent(active.id, initial.id, "node_finished", {
          nodeId: node.id,
          nodeName: node.name,
          status: "skipped",
          attempt,
          round: nodeRunOf(active, node.id).round,
          error: lastError,
        });
        return "skipped";
      }

      updateStatus(initial.id, "failed", {
        attempt,
        round: nodeRunOf(active, node.id).round,
        finishedAt,
        error: lastError,
      });
      emitEvent(active.id, initial.id, "node_finished", {
        nodeId: node.id,
        nodeName: node.name,
        status: "failed",
        attempt,
        round: nodeRunOf(active, node.id).round,
        error: lastError,
      });
      return "failed";
    }
  }

  interface AttemptOutcome {
    ok: boolean;
    canceled?: boolean;
    /** 人工审核驳回 / 修改轮数耗尽：不套用失败重试策略 */
    rejected?: boolean;
    /** 审核等待超时：运行按中断收尾，可续跑 */
    interrupted?: boolean;
    error: string;
    /** 本结果对应的修正轮次，从 1 开始 */
    round: number;
    /** 本轮执行结束时间（不含人工审核等待） */
    finishedAt: number;
    sessionId: string | null;
    attemptDir: string;
    inputPath: string;
    outputPath: string;
    summary: string;
  }

  /**
   * 一次「执行尝试」的共享上下文。
   *
   * 同一 attempt 内的多轮修正必须复用：
   * - sessionId：Nova 会话（消息落库与前端事件路由）
   * - runtimeDir / prepared：临时 CLAUDE_CONFIG_DIR 与 MCP 投影
   * 这样下一轮才能靠 --resume 接上同一个 CLI 会话。
   */
  interface AttemptChain {
    attempt: number;
    sessionId: string;
    runtimeDir: string;
    prepared: PreparedAgentRun;
    warnings: string[];
    agentLabel: string;
    runtimeConfig: Record<string, string>;
    systemPrompt: string;
    knowledge: ExecutionReportKnowledgeBase[];
  }

  async function cleanupRuntimeDir(runtimeDir: string): Promise<void> {
    try {
      await rm(runtimeDir, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 120,
      });
    } catch {
      // 清理失败不影响节点结果
    }
    try {
      await rmdir(dirname(runtimeDir));
    } catch {
      // run 目录下还有其它节点时保留
    }
  }

  /**
   * 为一次执行尝试创建会话与运行时投影。
   *
   * 只在 attempt 开始时调用一次；人工要求修改不会重建，否则会得到新的
   * CLAUDE_CONFIG_DIR，CLI 会话文件随之消失，--resume 就失效了。
   */
  async function createAttemptChain(
    active: ActiveRun,
    node: WorkflowNode,
    employee: DigitalEmployee,
    attempt: number,
  ): Promise<AttemptChain> {
    const nodeRun = nodeRunOf(active, node.id);
    const agentId = resolveAgentId();
    const provider = getProvider(agentId);
    if (!provider) {
      throw new Error(`Agent「${agentId}」不存在或未注册`);
    }

    // 运行时投影目录：一个 attempt 一份，整条修正链共用，结束统一删除
    const runtimeDir = join(
      deps.userDataDir,
      "workflow-runs",
      active.id,
      `${node.id}-attempt-${attempt}`,
    );

    let runtimeConfig: Record<string, string> = {};
    try {
      runtimeConfig = provider.describeRuntimeConfig?.() ?? {};
    } catch (err) {
      runtimeConfig = { "配置读取失败": messageOf(err) };
    }

    const warnings: string[] = [];
    const capabilities = provider.manifest.capabilities;
    const enabledSkills = employee.skills.filter((skill) => skill.enabled);
    const enabledMcp = employee.mcpServers.filter((server) => server.enabled);
    if (enabledSkills.length > 0 && !capabilities.skills) {
      warnings.push(
        `当前 Agent（${agentId}）不支持技能注入，本次已忽略 ${enabledSkills.length} 个技能。`,
      );
    }
    if (enabledMcp.length > 0 && !capabilities.mcp) {
      warnings.push(
        `当前 Agent（${agentId}）不支持 MCP 注入，本次已忽略 ${enabledMcp.length} 个 MCP 服务。`,
      );
    }

    // 知识库属于员工能力的一部分：解析成目录清单后写进系统提示词
    const knowledge = await resolveEmployeeKnowledge(employee.knowledgeBases);
    warnings.push(...knowledge.warnings);

    const systemPrompt = buildSystemPrompt(employee, knowledge.promptSection);

    // 运行时投影目录：一个 attempt 一份，整条修正链共用，结束统一删除
    await ensureDir(runtimeDir);

    const session = db.createSession(
      agentId,
      active.workspaceId,
      active.workspacePath,
      `工作流「${active.workflow.name}」· ${node.name} · 第 ${attempt} 次`,
      null,
      "workflow",
    );
    active.sessions.add(session.id);

    const opts: SessionOptions = {};
    if (systemPrompt) opts.systemPrompt = systemPrompt;

    let prepared: PreparedAgentRun;
    try {
      // 由 provider 决定是否需要运行时投影（Claude 按员工 MCP/Skill 子集生成临时配置）
      prepared =
        (await provider.prepareRun?.({
          mode: "workflow",
          sessionId: session.id,
          cwd: active.workspacePath,
          runtimeDir,
          employee,
          opts,
        })) ?? {};
    } catch (err) {
      // 投影失败：会话还没有任何消息，直接回收，避免留下隐形空会话；
      // 临时目录可能已复制了凭证 / 技能，也必须在这里清掉。
      active.sessions.delete(session.id);
      db.deleteSession(session.id);
      await cleanupRuntimeDir(runtimeDir);
      throw err;
    }

    warnings.push(...(prepared.warnings ?? []));
    for (const message of warnings) {
      emitEvent(active.id, nodeRun.id, "log", {
        level: "warning",
        message,
        attempt,
      });
    }

    return {
      attempt,
      sessionId: session.id,
      runtimeDir,
      prepared,
      warnings,
      agentLabel: `${provider.manifest.displayName}（${provider.manifest.id}）`,
      runtimeConfig,
      systemPrompt,
      knowledge: knowledge.bases.map((base) => ({
        name: base.name,
        path: base.path,
        fileCount: base.fileCount,
      })),
    };
  }

  async function runRound(
    active: ActiveRun,
    node: WorkflowNode,
    employee: DigitalEmployee,
    chain: AttemptChain,
    round: number,
    kind: WorkflowNodeAttemptKind,
    feedback = "",
  ): Promise<AttemptOutcome> {
    const nodeRun = nodeRunOf(active, node.id);
    const attemptDir = nodeArtifactDir(
      active.runDir,
      node,
      active.order.findIndex((item) => item.id === node.id),
      chain.attempt,
      round,
    );
    await ensureDir(attemptDir);

    // execution.md：完整执行现场（Agent 配置 / 注入能力 / 命令行 / 提示词 / 结果）
    const inputPath = join(attemptDir, "execution.md");
    const outputPath = join(attemptDir, "result.md");
    const attemptStartedAt = Date.now();
    const timeoutSetting = Number(db.getSetting("agentTimeoutMinutes"));
    const timeoutMinutes =
      Number.isFinite(timeoutSetting) && timeoutSetting > 0
        ? Math.max(1, Math.round(timeoutSetting))
        : DEFAULT_SETTINGS.agentTimeoutMinutes;
    const maxRetries = effectiveMaxRetries(node);
    const maxRevisions = effectiveMaxRevisions(node);

    const reportState: {
      invocation: AgentInvocationInfo | null;
      outcome: RunOutcome | null;
      error: string | null;
      sessionRef: string | null;
    } = {
      invocation: null,
      outcome: null,
      error: null,
      sessionRef: null,
    };
    const reportContext: {
      prompt: string;
    } = { prompt: "" };

    let reportChain: Promise<void> = Promise.resolve();
    /** 每轮都重写一份完整报告；链式写入保证最终内容是最新的 */
    const writeReport = (): void => {
      const content = buildExecutionReport({
        runId: active.id,
        workflowId: active.workflow.id,
        workflowName: active.workflow.name,
        workspacePath: active.workspacePath,
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        employeeId: employee.id,
        employeeName: employee.name,
        employeeRole: employee.role,
        attempt: chain.attempt,
        round,
        kind,
        maxRetries,
        maxRevisions,
        failureStrategy: node.config.failureStrategy,
        reviewMode: node.config.reviewMode,
        startedAt: attemptStartedAt,
        timeoutMinutes,
        sessionId: chain.sessionId,
        sessionRef: reportState.sessionRef,
        agentLabel: chain.agentLabel,
        runtimeConfig: chain.runtimeConfig,
        runtimeDir: chain.runtimeDir,
        prepared: chain.prepared,
        invocation: reportState.invocation,
        knowledge: chain.knowledge,
        warnings: chain.warnings,
        systemPrompt: chain.systemPrompt,
        prompt: reportContext.prompt,
        outcome: reportState.outcome,
        error: reportState.error,
      });
      reportChain = reportChain
        .then(() => writeText(inputPath, content))
        .catch(() => {
          // 报告写入失败不影响执行
        });
    };

    // 运行中的事件只留在内存里，供运行记录中途打开时回放
    active.live.set(nodeRun.id, {
      attempt: chain.attempt,
      round,
      seq: 0,
      events: [],
    });

    const attemptId = randomUUID();
    try {
      // 先登记本轮调用；消息边界在运行结束后回填
      db.createWorkflowNodeAttempt({
        id: attemptId,
        runId: active.id,
        nodeRunId: nodeRun.id,
        attempt: chain.attempt,
        round,
        kind,
        sessionId: chain.sessionId,
        artifactDir: attemptDir,
      });
      db.updateWorkflowNodeRun(nodeRun.id, {
        sessionId: chain.sessionId,
        inputPath,
        // 先指向本轮路径：即使本轮失败，结果页也不会继续展示上一轮的旧结果
        outputPath,
        artifactDir: attemptDir,
        outputSummary: null,
        round,
      });
      writeReport();

      const prompt =
        kind === "revise"
          ? buildRevisionPrompt(feedback)
          : buildPrompt(active, node);
      reportContext.prompt = prompt;
      writeReport();

      // 兄弟节点已经失败停止：不要为新节点再拉起 Agent 进程
      if (active.canceled || active.stopping) {
        return failedAttempt(
          "运行已停止",
          true,
          chain.sessionId,
          attemptDir,
          inputPath,
          outputPath,
          round,
        );
      }

      const texts: string[] = [];
      const deltas: string[] = [];
      /** 运行时错误（超时 / 启动失败等）：非零退出码时要给用户具体原因 */
      let runtimeError = "";
      const result = await deps.service.run({
        sessionId: chain.sessionId,
        prompt,
        cwd: active.workspacePath,
        opts: chain.systemPrompt ? { systemPrompt: chain.systemPrompt } : {},
        env: chain.prepared.env,
        envRemove: chain.prepared.envRemove,
        extraArgs: chain.prepared.extraArgs,
        // 用户消息一落库就记下本轮起点：运行中查看详情时也能正确切分轮次
        onUserMessage: (messageId) => {
          db.updateWorkflowNodeAttemptMessages(attemptId, {
            userMessageId: messageId,
          });
        },
        onInvocation: (info) => {
          reportState.invocation = info;
          writeReport();
        },
        onEvent: (event) => {
          // 实时链路：先在内存里留一份快照，再推给渲染层。
          // seq 始终递增；快照超过上限后只停止保留前缀，
          // 推送仍然连续，运行记录中途打开时按 seq 合并即可。
          const live = active.live.get(nodeRun.id);
          if (live && live.attempt === chain.attempt && live.round === round) {
            live.seq += 1;
            if (live.events.length < LIVE_EVENT_LIMIT) {
              live.events.push(event);
            }
            deps.emitAgentEvent({
              runId: active.id,
              nodeRunId: nodeRun.id,
              attempt: chain.attempt,
              round,
              seq: live.seq,
              event,
            });
          }

          if (event.type === "text") texts.push(event.content);
          else if (event.type === "text_delta") deltas.push(event.delta);
          else if (event.type === "error") runtimeError = event.message;
        },
      });

      // 本轮消息边界：多轮共用会话时，运行详情靠它切分对话
      db.updateWorkflowNodeAttemptMessages(attemptId, {
        userMessageId: result.userMessageId ?? null,
        assistantMessageId: result.assistantMessageId ?? null,
      });

      reportState.outcome =
        result.exitCode !== 0
          ? {
              ...result,
              ok: false,
              error: runtimeError || result.error,
            }
          : result;
      if (active.canceled) reportState.error = "运行已取消";
      reportState.sessionRef =
        db.getSession(chain.sessionId)?.agentSessionId ?? null;
      writeReport();
      await reportChain;

      if (active.canceled) {
        return failedAttempt(
          "运行已取消",
          true,
          chain.sessionId,
          attemptDir,
          inputPath,
          outputPath,
          round,
        );
      }
      if (result.aborted) {
        return failedAttempt(
          "运行被中断",
          true,
          chain.sessionId,
          attemptDir,
          inputPath,
          outputPath,
          round,
        );
      }
      if (!result.ok) {
        return failedAttempt(
          result.error ?? "Agent 启动失败",
          false,
          chain.sessionId,
          attemptDir,
          inputPath,
          outputPath,
          round,
        );
      }
      if (result.exitCode !== 0) {
        return failedAttempt(
          runtimeError || `Agent 退出码 ${result.exitCode}`,
          false,
          chain.sessionId,
          attemptDir,
          inputPath,
          outputPath,
          round,
        );
      }
      if (result.resumeFailed) {
        // 修改轮没有接上原会话：不能把「全新上下文跑出来的内容」当成修改结果
        return failedAttempt(
          "修改失败：CLI 已找不到上一轮的会话，无法在同一上下文中继续修改",
          false,
          chain.sessionId,
          attemptDir,
          inputPath,
          outputPath,
          round,
        );
      }

      /*
       * 结果优先取 agent-service 返回的本轮正文：
       * 它来自权威 message_end 块，能精确归属到当前轮。
       * 缺少时再退回累积的 text / delta，兼容不提供部分消息的版本。
       */
      const output =
        result.assistantText?.trim() ||
        texts.join("\n\n").trim() ||
        deltas.join("").trim() ||
        "（无文本输出）";
      await writeText(outputPath, output);

      return {
        ok: true,
        error: "",
        round,
        finishedAt: Date.now(),
        sessionId: chain.sessionId,
        attemptDir,
        inputPath,
        outputPath,
        summary: truncate(output, UPSTREAM_SUMMARY_LIMIT),
      };
    } catch (err) {
      // 异常（配置投影失败、落盘失败等）也要记到节点上，
      // 而不是冒泡成「运行失败 + 节点被标记取消」这种无法排查的状态。
      // 同时清掉实时快照：错误可能发生在内层 try 之前，不会走它的 finally。
      active.live.delete(nodeRun.id);

      const message = messageOf(err);
      reportState.error = message;
      reportState.sessionRef =
        db.getSession(chain.sessionId)?.agentSessionId ??
        reportState.sessionRef;
      writeReport();
      await reportChain;

      return failedAttempt(
        message,
        false,
        chain.sessionId,
        attemptDir,
        inputPath,
        outputPath,
        round,
      );
    } finally {
      // 保证报告文件在本轮结束前落盘
      await reportChain;
      active.live.delete(nodeRun.id);
    }
  }

  /**
   * 一次执行尝试的完整链路：初次执行 + 人工审核 + 要求修改。
   *
   * - 执行失败：直接返回，交给外层按失败策略处理（通常会开新 attempt）
   * - 人工审核通过：返回成功
   * - 要求修改：复用同一会话，round+1 再跑一轮
   * - 驳回 / 修改轮数耗尽：标记 rejected，外层直接终止节点
   */
  async function runChain(
    active: ActiveRun,
    node: WorkflowNode,
    employee: DigitalEmployee,
    attempt: number,
  ): Promise<AttemptOutcome> {
    const nodeRun = nodeRunOf(active, node.id);
    let chain: AttemptChain | null = null;
    let lastOutcome: AttemptOutcome | null = null;
    let lastFinishedAt = Date.now();

    try {
      try {
        chain = await createAttemptChain(active, node, employee, attempt);
      } catch (err) {
        // 投影 / 会话创建失败：仍然按节点失败处理，让失败策略生效
        const attemptDir = nodeArtifactDir(
          active.runDir,
          node,
          active.order.findIndex((item) => item.id === node.id),
          attempt,
          1,
        );
        await ensureDir(attemptDir);
        return failedAttempt(
          messageOf(err),
          false,
          null,
          attemptDir,
          join(attemptDir, "execution.md"),
          join(attemptDir, "result.md"),
          1,
        );
      }

      let round = 1;
      let kind: WorkflowNodeAttemptKind = attempt > 1 ? "retry" : "initial";
      let feedback = "";

      while (true) {
        const outcome = await runRound(
          active,
          node,
          employee,
          chain,
          round,
          kind,
          feedback,
        );
        lastOutcome = outcome;
        lastFinishedAt = outcome.finishedAt;

        if (!outcome.ok) return outcome;
        if (node.config.reviewMode !== "manual") return outcome;

        const decision = await reviewNodeOutput(
          active,
          node,
          employee,
          nodeRun.id,
          attempt,
          round,
          outcome,
        );

        if (decision.action === "approve") return outcome;

        if (decision.action === "reject") {
          const reason = decision.note
            ? `人工审核驳回：${decision.note}`
            : "人工审核驳回";
          emitEvent(active.id, nodeRun.id, "log", {
            level: "warning",
            message: `${reason}，本次运行已终止`,
            attempt,
            round,
          });
          return {
            ...outcome,
            ok: false,
            rejected: true,
            error: reason,
            finishedAt: lastFinishedAt,
          };
        }

        // ---- 要求修改：复用同一会话与配置目录，开始下一轮 ----
        const maxRevisions = effectiveMaxRevisions(node);
        if (round - 1 >= maxRevisions) {
          const reason = `已达到最大修改轮数（${maxRevisions}），本次运行已终止`;
          // 与人工驳回一致：终止后不允许再通过「继续运行」绕过轮数限制
          db.updateWorkflowNodeRun(nodeRun.id, {
            decision: "rejected",
            decisionNote: `已达到最大修改轮数（${maxRevisions}）`,
            decidedAt: Date.now(),
          });
          emitEvent(active.id, nodeRun.id, "log", {
            level: "warning",
            message: reason,
            attempt,
            round,
          });
          return {
            ...outcome,
            ok: false,
            rejected: true,
            error: reason,
            finishedAt: lastFinishedAt,
          };
        }

        round += 1;
        kind = "revise";
        feedback = decision.note;
        db.updateWorkflowNodeRun(nodeRun.id, {
          attempt,
          round,
          error: null,
          finishedAt: null,
        });
        updateStatus(nodeRun.id, "running", {
          attempt,
          round,
          startedAt: Date.now(),
          finishedAt: null,
          error: null,
        });
        emitEvent(active.id, nodeRun.id, "node_status", {
          nodeId: node.id,
          nodeName: node.name,
          status: "running",
          attempt,
          round,
        });
      }
    } catch (err) {
      if (err instanceof ApprovalTimeoutError) {
        // 没人审核：按中断处理，保留产物，运行可续跑
        if (lastOutcome) {
          return {
            ...lastOutcome,
            ok: false,
            interrupted: true,
            error: err.message,
            finishedAt: lastOutcome.finishedAt,
          };
        }
        return failedAttempt(
          err.message,
          false,
          null,
          "",
          "",
          "",
          1,
          lastFinishedAt,
        );
      }
      throw err;
    } finally {
      if (chain) {
        active.sessions.delete(chain.sessionId);
        await cleanupRuntimeDir(chain.runtimeDir);
      }
    }
  }

  async function failedAttempt(
    error: string,
    canceled: boolean,
    sessionId: string | null,
    attemptDir: string,
    inputPath: string,
    outputPath: string,
    round: number,
    finishedAt = Date.now(),
  ): Promise<AttemptOutcome> {
    // 失败也留一份结果文件：用户点开产物目录能看到失败原因，
    // 而不是只有一个空目录或空文件
    if (outputPath) {
      await writeText(outputPath, `执行失败：${error}`).catch(() => {});
    }
    return {
      ok: false,
      canceled,
      error,
      round,
      finishedAt,
      sessionId,
      attemptDir,
      inputPath,
      outputPath,
      summary: "",
    };
  }

  // ==========================================================================
  // 审批 / 取消 / 收尾
  // ==========================================================================

  /**
   * 人工审核（执行后）：产物已经生成，等人工确认。
   *
   * 返回最终决定：
   * - approve：节点可以完成
   * - reject：产物不合格，终止整条运行
   * - revise：带着评审意见在同一会话里再执行一轮
   *
   * 请求修改不写最终 decision，避免被当成「已审核」；
   * 哪些轮次改过由 approval_decided 事件和 attempts 记录还原。
   */
  async function reviewNodeOutput(
    active: ActiveRun,
    node: WorkflowNode,
    employee: DigitalEmployee,
    nodeRunId: string,
    attempt: number,
    round: number,
    outcome: AttemptOutcome,
  ): Promise<ApprovalDecision> {
    // 产物先落库：审批界面要能直接读到结果，而不是只有一个任务描述。
    // 同时定格 finishedAt，避免把人工等待的时间算进节点耗时。
    updateStatus(nodeRunId, "awaiting_approval", {
      attempt,
      round,
      finishedAt: outcome.finishedAt,
      sessionId: outcome.sessionId,
      artifactDir: outcome.attemptDir,
      inputPath: outcome.inputPath,
      outputPath: outcome.outputPath,
      outputSummary: outcome.summary,
    });
    db.updateWorkflowRun(active.id, { status: "awaiting_approval" });

    const maxRevisions = effectiveMaxRevisions(node);
    const remainingRevisions = Math.max(0, maxRevisions - (round - 1));
    emitEvent(active.id, nodeRunId, "approval_required", {
      nodeId: node.id,
      nodeName: node.name,
      employeeName: employee.name,
      taskDetail: node.config.taskDetail,
      attempt,
      round,
      remainingRevisions,
      outputPath: outcome.outputPath,
      summary: outcome.summary,
    });

    const decision = await waitApproval(active, nodeRunId);
    if (decision.action === "cancel" || active.canceled) {
      throw new CanceledError();
    }
    if (decision.action === "timeout") {
      // 超时不是驳回：不写 decision，让这条运行之后还能继续执行
      throw new ApprovalTimeoutError(
        `节点「${node.name}」等待人工审核超时（${decision.note}），本次运行已中断；继续执行会重新执行该节点并重新审核`,
      );
    }

    emitEvent(active.id, nodeRunId, "approval_decided", {
      nodeId: node.id,
      decision: decision.action,
      note: decision.note,
      attempt,
      round,
    });

    if (decision.action === "revise") {
      // 修改不是最终决定：清空 decision 字段，节点回到 running 等下一轮
      db.updateWorkflowNodeRun(nodeRunId, {
        decision: null,
        decisionNote: null,
        decidedAt: null,
      });
      restoreRunStatusAfterDecision(active, nodeRunId);
      return decision;
    }

    db.updateWorkflowNodeRun(nodeRunId, {
      decision: decision.action === "approve" ? "approved" : "rejected",
      decisionNote: decision.note || null,
      decidedAt: Date.now(),
    });
    restoreRunStatusAfterDecision(active, nodeRunId);
    return decision;
  }

  /**
   * 并行分支可能还有别的节点在等审核：run 状态不能简单切回 running。
   * 运行可能已被取消 / 终止，也不能被一次迟到的审批回翻。
   */
  function restoreRunStatusAfterDecision(
    active: ActiveRun,
    nodeRunId: string,
  ): void {
    const stillAwaiting =
      active.approvals.size > 0 ||
      db
        .listWorkflowNodeRuns(active.id)
        .some(
          (item) => item.id !== nodeRunId && item.status === "awaiting_approval",
        );
    if (stillAwaiting) {
      db.updateWorkflowRun(active.id, { status: "awaiting_approval" });
      return;
    }
    const run = db.getWorkflowRun(active.id);
    if (run?.status === "awaiting_approval") {
      db.updateWorkflowRun(active.id, { status: "running" });
    }
  }

  function waitApproval(
    active: ActiveRun,
    nodeRunId: string,
  ): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!active.approvals.has(nodeRunId)) return;
        active.approvals.delete(nodeRunId);
        emitEvent(active.id, nodeRunId, "log", {
          level: "warning",
          message: `等待人工审核超过 ${Math.round(
            APPROVAL_TIMEOUT_MS / 60000,
          )} 分钟，本次运行按中断处理，可稍后继续执行`,
        });
        // 超时只是没人确认：交给调用方按「中断」收尾，不能写成人工驳回
        resolve({
          action: "timeout",
          note: `超过 ${Math.round(APPROVAL_TIMEOUT_MS / 60000)} 分钟未确认`,
        });
      }, APPROVAL_TIMEOUT_MS);

      active.approvals.set(nodeRunId, { resolve, timer });
    });
  }

  function approve(
    runId: string,
    nodeRunId: string,
    action: "approve" | "reject" | "revise",
    note?: string,
  ): boolean {
    const active = activeRuns.get(runId);
    if (!active) return false;
    const entry = active.approvals.get(nodeRunId);
    if (!entry) return false;

    active.approvals.delete(nodeRunId);
    clearTimeout(entry.timer);
    entry.resolve({ action, note: note?.trim() ?? "" });
    return true;
  }

  function cancel(runId: string): boolean {
    const active = activeRuns.get(runId);
    if (!active) return false;
    active.canceled = true;
    active.stopping = true;
    abortSessions(active);
    cancelApprovals(active);
    return true;
  }

  function finish(
    active: ActiveRun,
    status: WorkflowRunStatus,
    error?: string,
  ): void {
    if (!activeRuns.has(active.id)) return;
    const finishedAt = Date.now();
    db.updateWorkflowRun(active.id, {
      status,
      error: error ?? null,
      finishedAt,
    });

    if (status !== "succeeded") {
      for (const nodeRun of db.listWorkflowNodeRuns(active.id)) {
        if (
          nodeRun.status === "pending" ||
          nodeRun.status === "running" ||
          nodeRun.status === "awaiting_approval" ||
          nodeRun.status === "retrying"
        ) {
          db.updateWorkflowNodeRun(nodeRun.id, {
            status: "canceled",
            finishedAt,
          });
        }
      }
    }

    emitEvent(active.id, null, "run_finished", {
      status,
      error: error ?? null,
    });
    activeRuns.delete(active.id);
    const finished = db.getWorkflowRun(active.id);
    if (finished) deps.onRunFinished?.(finished);
  }

  function nodeFailureMessage(active: ActiveRun, node: WorkflowNode): string {
    const nodeRun = nodeRunOf(active, node.id);
    return nodeRun.error || `节点「${node.name}」执行失败`;
  }

  function hasActiveRunForWorkflow(workflowId: string): boolean {
    // 包含“正在做启动校验”的占位运行，避免启动瞬间删除工作流
    return workflowBusy(workflowId);
  }

  function hasActiveRunInWorkspace(workspaceId: string): boolean {
    return workspaceBusy(workspaceId);
  }

  function liveTranscript(
    runId: string,
    nodeRunId: string,
  ): { attempt: number; round: number; seq: number; events: AgentEvent[] } | null {
    const entry = activeRuns.get(runId)?.live.get(nodeRunId);
    // 复制一份：调用方随后会 await 文件读取，期间事件还在追加
    return entry
      ? {
          attempt: entry.attempt,
          round: entry.round,
          seq: entry.seq,
          events: [...entry.events],
        }
      : null;
  }

  function shutdown(): void {
    for (const active of [...activeRuns.values()]) {
      active.canceled = true;
      active.stopping = true;
      abortSessions(active);
      cancelApprovals(active);

      const finishedAt = Date.now();
      db.updateWorkflowRun(active.id, {
        status: "interrupted",
        error: "应用已退出，运行被中断",
        finishedAt,
      });
      // 同一会话内也要把节点状态收干净，不能只改 run 状态
      for (const nodeRun of db.listWorkflowNodeRuns(active.id)) {
        if (
          nodeRun.status === "pending" ||
          nodeRun.status === "running" ||
          nodeRun.status === "awaiting_approval" ||
          nodeRun.status === "retrying"
        ) {
          db.updateWorkflowNodeRun(nodeRun.id, {
            status: "canceled",
            finishedAt,
          });
        }
      }
      emitEvent(active.id, null, "run_finished", {
        status: "interrupted",
        error: "应用已退出，运行被中断",
      });
      const finished = db.getWorkflowRun(active.id);
      if (finished) deps.onRunFinished?.(finished);
    }
    activeRuns.clear();
  }

  // ==========================================================================
  // 提示词
  // ==========================================================================

  function buildSystemPrompt(
    employee: DigitalEmployee,
    knowledgeSection: string,
  ): string {
    return [
      employee.role
        ? `你是「${employee.name}」，职位：${employee.role}。`
        : `你是「${employee.name}」。`,
      // 简介已从员工配置中移除，身份与职责统一由系统提示词表达
      employee.systemPrompt,
      knowledgeSection,
      [
        "## 工作流协作约定",
        "你的最终回复会作为该节点的产物，交给下游节点使用。",
        "请只输出最终结论或交付物说明，不要重复分析过程；",
        "如果需要下游读取文件，请写出文件的完整路径。",
      ].join("\n"),
    ]
      .filter((part) => part && part.trim())
      .join("\n\n");
  }

  function buildPrompt(active: ActiveRun, node: WorkflowNode): string {
    const parts: string[] = [];
    parts.push(
      node.config.taskDetail.trim() ||
        `请完成节点「${node.name}」分配给你的任务。`,
    );

    const upstreamIds = active.predecessors.get(node.id) ?? [];
    if (upstreamIds.length > 0) {
      // 一次取出全部节点运行记录，避免每个上游节点都查一遍数据库
      const nodeRuns = db.listWorkflowNodeRuns(active.id);
      const blocks = upstreamIds.map((predecessorId) => {
        const predecessor = active.order.find(
          (item) => item.id === predecessorId,
        );
        const nodeRun = nodeRuns.find((item) => item.nodeId === predecessorId);
        if (!nodeRun) return "";
        if (nodeRun.status === "skipped") {
          return `### 上游节点：${predecessor?.name ?? predecessorId}\n状态：已跳过，无产物。`;
        }
        return [
          `### 上游节点：${predecessor?.name ?? predecessorId}`,
          `状态：${nodeRun.status}`,
          nodeRun.outputPath ? `产物文件：${nodeRun.outputPath}` : "",
          nodeRun.artifactDir ? `产物目录：${nodeRun.artifactDir}` : "",
          nodeRun.outputSummary
            ? `输出摘要：\n${nodeRun.outputSummary}`
            : "输出摘要：无",
          "需要完整内容时，请直接读取上面的产物文件。",
        ]
          .filter(Boolean)
          .join("\n");
      });
      parts.push(`## 上游产物\n\n${blocks.filter(Boolean).join("\n\n")}`);
    }

    return parts.join("\n\n---\n\n");
  }

  /**
   * 人工要求修改时的输入。
   *
   * 复用同一个会话，因此不再重复上游产物与任务详情：Agent 上一轮已经看过。
   * 只把评审意见交给它，并要求直接产出最终版本。
   */
  function buildRevisionPrompt(feedback: string): string {
    const note = feedback.trim();
    return [
      "上一次输出未通过人工审核，请基于你上一次的产物直接修改，不要从头重做。",
      note ? `审核意见：${note}` : "审核人未填写具体意见，请自行复核并改进。",
      "修改完成后，只输出最终的完整版本。",
    ].join("\n\n");
  }

  async function delay(active: ActiveRun, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (active.canceled || active.stopping) throw new CanceledError();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return {
    start,
    resume,
    cancel,
    approve,
    hasActiveRunForWorkflow,
    hasActiveRunInWorkspace,
    liveTranscript,
    shutdown,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
