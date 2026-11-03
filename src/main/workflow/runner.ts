/**
 * 工作流运行引擎（P0）
 *
 * 模型：工作流是编排器，每个节点是一次独立的数字员工执行。
 * - 严格串行：只有上一个节点成功/跳过后，下一个节点才启动
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
import type { AgentService, RunOutcome } from "../engine/agent-service";
import * as db from "../db/sqlite";
import {
  DEFAULT_SETTINGS,
  type AgentEvent,
  type DigitalEmployee,
  type SessionOptions,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeRun,
  type WorkflowNodeRunStatus,
  type WorkflowRun,
  type WorkflowRunEvent,
  type WorkflowRunEventType,
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

class CanceledError extends Error {
  constructor() {
    super("运行已取消");
    this.name = "CanceledError";
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

interface ActiveRun {
  id: string;
  workflow: Workflow;
  workspaceId: string;
  workspacePath: string;
  runDir: string;
  order: WorkflowNode[];
  predecessors: Map<string, string[]>;
  employees: Map<string, DigitalEmployee>;
  /** nodeId → 本次运行的节点执行记录 */
  nodeRuns: Map<string, WorkflowNodeRun>;
  canceled: boolean;
  currentSessionId: string | null;
  approvals: Map<string, (decision: "approve" | "reject" | "cancel") => void>;
  /**
   * nodeRunId → 本次尝试的原始事件（不落库）。
   * 运行记录中途打开时用它回放已产生的对话，之后的增量走推送。
   */
  live: Map<
    string,
    { attempt: number; seq: number; events: AgentEvent[] }
  >;
}

export interface WorkflowRunner {
  /** 启动前会先做 Agent 安装 / 连接配置校验，因此是异步的 */
  start(workflowId: string): Promise<WorkflowRun>;
  cancel(runId: string): boolean;
  approve(
    runId: string,
    nodeRunId: string,
    action: "approve" | "reject",
    note?: string,
  ): boolean;
  /** 删除工作流 / 工作区前检查是否有活跃运行 */
  hasActiveRunForWorkflow(workflowId: string): boolean;
  hasActiveRunInWorkspace(workspaceId: string): boolean;
  /** 运行中节点的实时事件快照；节点不在运行时返回 null */
  liveTranscript(
    runId: string,
    nodeRunId: string,
  ): { attempt: number; seq: number; events: AgentEvent[] } | null;
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
    seq: number;
    event: AgentEvent;
  }) => void;
  userDataDir: string;
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

  async function start(workflowId: string): Promise<WorkflowRun> {
    const workflow = db.getWorkflow(workflowId);
    if (!workflow) throw new Error("工作流不存在");

    const workspace = db.getProject(workflow.workspaceId);
    if (!workspace) {
      throw new Error("工作流未绑定工作区，请先在编辑器中选一个工作区");
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
          maxRetries:
            node.config.failureStrategy === "retry"
              ? node.config.maxRetries
              : 0,
        });
      }

      const active: ActiveRun = {
        id: runId,
        workflow,
        workspaceId: workspace.id,
        workspacePath: workspace.cwd,
        runDir,
        order: validated.order,
        predecessors: validated.predecessors,
        employees,
        nodeRuns: new Map(
          db
            .listWorkflowNodeRuns(runId)
            .map((nodeRun) => [nodeRun.nodeId, nodeRun] as const),
        ),
        canceled: false,
        currentSessionId: null,
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

  async function execute(active: ActiveRun): Promise<void> {
    try {
      for (const node of active.order) {
        if (active.canceled) throw new CanceledError();

        const outcome = await executeNode(active, node);
        if (active.canceled || outcome === "canceled") {
          throw new CanceledError();
        }
        if (outcome === "failed") {
          finish(active, "failed", nodeFailureMessage(active, node));
          return;
        }
      }
      finish(active, "succeeded");
    } catch (err) {
      if (err instanceof CanceledError || active.canceled) {
        finish(active, "canceled");
      } else {
        finish(active, "failed", messageOf(err));
      }
    }
  }

  async function executeNode(
    active: ActiveRun,
    node: WorkflowNode,
  ): Promise<"succeeded" | "skipped" | "failed" | "canceled"> {
    const employee = active.employees.get(node.config.employeeId ?? "");
    if (!employee) throw new Error(`节点「${node.name}」没有可用数字员工`);

    const initial = nodeRunOf(active, node.id);
    const startedAt = Date.now();
    updateStatus(initial.id, "running", { startedAt, error: null });
    emitEvent(active.id, initial.id, "node_status", {
      nodeId: node.id,
      nodeName: node.name,
      status: "running",
    });

    const maxRetries =
      node.config.failureStrategy === "retry" ? node.config.maxRetries : 0;
    let attempt = initial.attempt || 1;
    let lastError = "";

    while (true) {
      if (active.canceled) throw new CanceledError();

      // ---- 审核门禁：执行前等待人工决定 ----
      if (node.config.reviewMode === "manual") {
        updateStatus(initial.id, "awaiting_approval", { attempt });
        db.updateWorkflowRun(active.id, { status: "awaiting_approval" });
        emitEvent(active.id, initial.id, "approval_required", {
          nodeId: node.id,
          nodeName: node.name,
          employeeName: employee.name,
          taskDetail: node.config.taskDetail,
          attempt,
        });

        const decision = await waitApproval(active, initial.id);
        if (decision === "cancel" || active.canceled) throw new CanceledError();

        db.updateWorkflowNodeRun(initial.id, {
          decision: decision === "approve" ? "approved" : "rejected",
          decidedAt: Date.now(),
        });
        emitEvent(active.id, initial.id, "approval_decided", {
          nodeId: node.id,
          decision,
        });
        db.updateWorkflowRun(active.id, { status: "running" });

        if (decision === "reject") {
          lastError = "人工审核驳回";
        } else {
          lastError = "";
        }
      }

      if (!lastError) {
        // 审批通过 / 重试后再执行：把状态切回 running，界面不会一直停在“等待审核”
        updateStatus(initial.id, "running", { attempt });
        emitEvent(active.id, initial.id, "node_status", {
          nodeId: node.id,
          nodeName: node.name,
          status: "running",
          attempt,
        });
        const outcome = await runAttempt(active, node, employee, attempt);
        if (outcome.ok) {
          updateStatus(initial.id, "succeeded", {
            attempt,
            startedAt,
            finishedAt: Date.now(),
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
            sessionId: outcome.sessionId,
            outputPath: outcome.outputPath,
          });
          return "succeeded";
        }
        if (outcome.canceled) throw new CanceledError();
        lastError = outcome.error;
      }

      // ---- 失败处理 ----
      updateStatus(initial.id, "failed", { attempt, error: lastError });

      if (attempt <= maxRetries) {
        updateStatus(initial.id, "retrying", { attempt, error: lastError });
        emitEvent(active.id, initial.id, "node_retry", {
          nodeId: node.id,
          nodeName: node.name,
          attempt,
          maxRetries,
          error: lastError,
        });
        await delay(active, RETRY_BASE_MS * attempt);
        attempt += 1;
        // 必须清空上一轮错误，否则下一轮会跳过 runAttempt（只重试等待、不真正执行）
        lastError = "";
        db.updateWorkflowNodeRun(initial.id, { attempt, error: null });
        continue;
      }

      const finishedAt = Date.now();
      if (node.config.failureStrategy === "skip") {
        updateStatus(initial.id, "skipped", { attempt, finishedAt, error: lastError });
        emitEvent(active.id, initial.id, "node_finished", {
          nodeId: node.id,
          nodeName: node.name,
          status: "skipped",
          attempt,
          error: lastError,
        });
        return "skipped";
      }

      updateStatus(initial.id, "failed", { attempt, finishedAt, error: lastError });
      emitEvent(active.id, initial.id, "node_finished", {
        nodeId: node.id,
        nodeName: node.name,
        status: "failed",
        attempt,
        error: lastError,
      });
      return "failed";
    }
  }

  interface AttemptOutcome {
    ok: boolean;
    canceled?: boolean;
    error: string;
    sessionId: string | null;
    attemptDir: string;
    inputPath: string;
    outputPath: string;
    summary: string;
  }

  async function runAttempt(
    active: ActiveRun,
    node: WorkflowNode,
    employee: DigitalEmployee,
    attempt: number,
  ): Promise<AttemptOutcome> {
    const nodeRun = nodeRunOf(active, node.id);
    const attemptDir = nodeArtifactDir(
      active.runDir,
      node,
      active.order.findIndex((item) => item.id === node.id),
      attempt,
    );
    await ensureDir(attemptDir);

    // execution.md：完整执行现场（Agent 配置 / 注入能力 / 命令行 / 提示词 / 结果）
    const inputPath = join(attemptDir, "execution.md");
    const outputPath = join(attemptDir, "result.md");
    let sessionId: string | null = null;

    const attemptStartedAt = Date.now();
    const timeoutSetting = Number(db.getSetting("agentTimeoutMinutes"));
    const timeoutMinutes =
      Number.isFinite(timeoutSetting) && timeoutSetting > 0
        ? Math.max(1, Math.round(timeoutSetting))
        : DEFAULT_SETTINGS.agentTimeoutMinutes;
    const maxRetries =
      node.config.failureStrategy === "retry" ? node.config.maxRetries : 0;

    const reportState: {
      prepared: PreparedAgentRun | null;
      invocation: AgentInvocationInfo | null;
      outcome: RunOutcome | null;
      error: string | null;
      sessionId: string | null;
      sessionRef: string | null;
    } = {
      prepared: null,
      invocation: null,
      outcome: null,
      error: null,
      sessionId: null,
      sessionRef: null,
    };
    const reportContext: {
      systemPrompt: string;
      prompt: string;
      knowledge: ExecutionReportKnowledgeBase[];
      warnings: string[];
      runtimeConfig: Record<string, string>;
      agentLabel: string;
      runtimeDir: string | null;
    } = {
      systemPrompt: "",
      prompt: "",
      knowledge: [],
      warnings: [],
      runtimeConfig: {},
      agentLabel: "",
      runtimeDir: null,
    };

    let reportChain: Promise<void> = Promise.resolve();
    /** 每次调用都重写一份完整报告；链式写入保证最终内容是最新的 */
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
        attempt,
        maxRetries,
        failureStrategy: node.config.failureStrategy,
        reviewMode: node.config.reviewMode,
        startedAt: attemptStartedAt,
        timeoutMinutes,
        sessionId: reportState.sessionId,
        sessionRef: reportState.sessionRef,
        agentLabel: reportContext.agentLabel,
        runtimeConfig: reportContext.runtimeConfig,
        runtimeDir: reportContext.runtimeDir,
        prepared: reportState.prepared,
        invocation: reportState.invocation,
        knowledge: reportContext.knowledge,
        warnings: reportContext.warnings,
        systemPrompt: reportContext.systemPrompt,
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
    active.live.set(nodeRun.id, { attempt, seq: 0, events: [] });

    try {
      const agentId = resolveAgentId();
      const provider = getProvider(agentId);
      if (!provider) {
        throw new Error(`Agent「${agentId}」不存在或未注册`);
      }

      // 运行时投影目录：放在 userData 下，节点结束后删除；不写入工作区产物
      const runtimeDir = join(
        deps.userDataDir,
        "workflow-runs",
        active.id,
        `${node.id}-attempt-${attempt}`,
      );
      await ensureDir(runtimeDir);
      reportContext.runtimeDir = runtimeDir;
      reportContext.agentLabel = `${provider.manifest.displayName}（${provider.manifest.id}）`;
      try {
        reportContext.runtimeConfig = provider.describeRuntimeConfig?.() ?? {};
      } catch (err) {
        reportContext.runtimeConfig = {
          "配置读取失败": messageOf(err),
        };
      }

      const runtimeWarnings: string[] = [];
      reportContext.warnings = runtimeWarnings;
      const capabilities = provider.manifest.capabilities;
      const enabledSkills = employee.skills.filter((skill) => skill.enabled);
      const enabledMcp = employee.mcpServers.filter((server) => server.enabled);
      if (enabledSkills.length > 0 && !capabilities.skills) {
        runtimeWarnings.push(
          `当前 Agent（${agentId}）不支持技能注入，本次已忽略 ${enabledSkills.length} 个技能。`,
        );
      }
      if (enabledMcp.length > 0 && !capabilities.mcp) {
        runtimeWarnings.push(
          `当前 Agent（${agentId}）不支持 MCP 注入，本次已忽略 ${enabledMcp.length} 个 MCP 服务。`,
        );
      }

      // 知识库属于员工能力的一部分：解析成目录清单后写进系统提示词
      const knowledge = await resolveEmployeeKnowledge(employee.knowledgeBases);
      runtimeWarnings.push(...knowledge.warnings);

      const systemPrompt = buildSystemPrompt(employee, knowledge.promptSection);
      const prompt = buildPrompt(active, node);
      reportContext.systemPrompt = systemPrompt;
      reportContext.prompt = prompt;
      reportContext.knowledge = knowledge.bases.map((base) => ({
        name: base.name,
        path: base.path,
        fileCount: base.fileCount,
      }));

      const session = db.createSession(
        agentId,
        active.workspaceId,
        active.workspacePath,
        `工作流「${active.workflow.name}」· ${node.name} · 第 ${attempt} 次`,
        null,
        "workflow",
      );
      sessionId = session.id;
      reportState.sessionId = session.id;
      writeReport();
      db.updateWorkflowNodeRun(nodeRun.id, {
        sessionId: session.id,
        inputPath,
        artifactDir: attemptDir,
      });
      db.createWorkflowNodeAttempt({
        id: randomUUID(),
        runId: active.id,
        nodeRunId: nodeRun.id,
        attempt,
        sessionId: session.id,
        artifactDir: attemptDir,
      });
      active.currentSessionId = session.id;

      // 只注入宿主自己生成的内容；模型 / 权限 / 接入等运行方式
      // 完全继承 Agent 平台的本机配置。
      const opts: SessionOptions = {};
      if (systemPrompt) opts.systemPrompt = systemPrompt;

      try {
        // 由 provider 决定是否需要运行时投影（Claude 按员工 MCP/Skill 子集生成临时配置）
        const prepared =
          (await provider.prepareRun?.({
            mode: "workflow",
            sessionId: session.id,
            cwd: active.workspacePath,
            runtimeDir,
            employee,
            opts,
          })) ?? {};
        reportState.prepared = prepared;

        // configDir 指向本次运行的临时投影目录，节点结束后就会被删除。
        // 不写入 sessions：留着只会得到一个永远失效的路径。
        runtimeWarnings.push(...(prepared.warnings ?? []));
        writeReport();

        // 告警不再单独落文件，直接写进事件日志；运行详情按节点读取
        for (const message of runtimeWarnings) {
          emitEvent(active.id, nodeRun.id, "log", {
            level: "warning",
            message,
            attempt,
          });
        }

        const texts: string[] = [];
        const deltas: string[] = [];
        /** 运行时错误（超时 / 启动失败等）：非零退出码时要给用户具体原因 */
        let runtimeError = "";
        const result = await deps.service.run({
          sessionId: session.id,
          prompt,
          cwd: active.workspacePath,
          opts,
          env: prepared.env,
          envRemove: prepared.envRemove,
          extraArgs: prepared.extraArgs,
          onInvocation: (info) => {
            reportState.invocation = info;
            writeReport();
          },
          onEvent: (event) => {
            // 实时链路：先在内存里留一份快照，再推给渲染层。
            // seq 始终递增；快照超过上限后只停止保留前缀，
            // 推送仍然连续，运行记录中途打开时按 seq 合并即可。
            const live = active.live.get(nodeRun.id);
            if (live && live.attempt === attempt) {
              live.seq += 1;
              if (live.events.length < LIVE_EVENT_LIMIT) {
                live.events.push(event);
              }
              deps.emitAgentEvent({
                runId: active.id,
                nodeRunId: nodeRun.id,
                attempt,
                seq: live.seq,
                event,
              });
            }

            if (event.type === "text") texts.push(event.content);
            else if (event.type === "text_delta") deltas.push(event.delta);
            else if (event.type === "error") runtimeError = event.message;
          },
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
          db.getSession(session.id)?.agentSessionId ?? null;
        writeReport();
        await reportChain;

        if (active.canceled) {
          return failedAttempt("运行已取消", true, session.id, attemptDir, inputPath, outputPath);
        }
        if (result.aborted) {
          return failedAttempt("运行被中断", true, session.id, attemptDir, inputPath, outputPath);
        }
        if (!result.ok) {
          return failedAttempt(result.error ?? "Agent 启动失败", false, session.id, attemptDir, inputPath, outputPath);
        }
        if (result.exitCode !== 0) {
          return failedAttempt(
            runtimeError || `Agent 退出码 ${result.exitCode}`,
            false,
            session.id,
            attemptDir,
            inputPath,
            outputPath,
          );
        }

        /*
         * 结果优先取本地落库的 assistant 消息：
         * Claude 的正文以 message_end 块到达，只靠 text / text_delta 累积
         * 会在 “没有 partial messages” 的版本上得到空结果。
         * 落库消息已经过 appendEvent 收敛，是本次运行的权威文本。
         */
        const output =
          assistantTextFromSession(session.id) ||
          texts.join("\n\n").trim() ||
          deltas.join("").trim() ||
          "（无文本输出）";
        await writeText(outputPath, output);

        return {
          ok: true,
          error: "",
          sessionId: session.id,
          attemptDir,
          inputPath,
          outputPath,
          summary: truncate(output, UPSTREAM_SUMMARY_LIMIT),
        };
      } finally {
        // 保证报告文件在节点结束前落盘（后续还会清理 runtimeDir）
        await reportChain;
        active.currentSessionId = null;
        // 尝试结束后以 messages 表里的完整消息为准，实时快照不再需要
        active.live.delete(nodeRun.id);
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
    } catch (err) {
      // 异常（配置投影失败、落盘失败等）也要记到节点上，
      // 而不是冒泡成「运行失败 + 节点被标记取消」这种无法排查的状态。
      // 同时清掉实时快照：错误可能发生在内层 try 之前，不会走它的 finally。
      active.currentSessionId = null;
      active.live.delete(nodeRun.id);

      const message = messageOf(err);
      reportState.error = message;
      if (sessionId) {
        reportState.sessionRef =
          db.getSession(sessionId)?.agentSessionId ?? reportState.sessionRef;
      }
      writeReport();
      await reportChain;

      return failedAttempt(
        message,
        false,
        sessionId,
        attemptDir,
        inputPath,
        outputPath,
      );
    }
  }

  /**
   * 从会话的持久化消息里提取 assistant 正文。
   * 这是本次运行的权威结果（含 think / tool 之后的最终文本块）。
   */
  function assistantTextFromSession(sessionId: string): string {
    const messages = db.readSessionMessages(sessionId) ?? [];
    const parts: string[] = [];
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const event of message.content) {
        if (event.type === "text" && event.content.trim()) {
          parts.push(event.content.trim());
        }
      }
    }
    return parts.join("\n\n").trim();
  }

  async function failedAttempt(
    error: string,
    canceled: boolean,
    sessionId: string | null,
    attemptDir: string,
    inputPath: string,
    outputPath: string,
  ): Promise<AttemptOutcome> {
    // 失败也留一份结果文件：用户点开产物目录能看到失败原因，
    // 而不是只有一个空目录或空文件
    await writeText(outputPath, `执行失败：${error}`).catch(() => {});
    return {
      ok: false,
      canceled,
      error,
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

  function waitApproval(
    active: ActiveRun,
    nodeRunId: string,
  ): Promise<"approve" | "reject" | "cancel"> {
    return new Promise((resolve) => {
      active.approvals.set(nodeRunId, resolve);
    });
  }

  function approve(
    runId: string,
    nodeRunId: string,
    action: "approve" | "reject",
    _note?: string,
  ): boolean {
    const active = activeRuns.get(runId);
    if (!active) return false;
    const resolver = active.approvals.get(nodeRunId);
    if (!resolver) return false;

    active.approvals.delete(nodeRunId);
    resolver(action);
    return true;
  }

  function cancel(runId: string): boolean {
    const active = activeRuns.get(runId);
    if (!active) return false;
    active.canceled = true;
    if (active.currentSessionId) {
      deps.service.abort(active.currentSessionId);
    }
    for (const resolver of active.approvals.values()) resolver("cancel");
    active.approvals.clear();
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
  ): { attempt: number; seq: number; events: AgentEvent[] } | null {
    const entry = activeRuns.get(runId)?.live.get(nodeRunId);
    // 复制一份：调用方随后会 await 文件读取，期间事件还在追加
    return entry
      ? { attempt: entry.attempt, seq: entry.seq, events: [...entry.events] }
      : null;
  }

  function shutdown(): void {
    for (const active of [...activeRuns.values()]) {
      active.canceled = true;
      if (active.currentSessionId) {
        deps.service.abort(active.currentSessionId);
      }
      for (const resolver of active.approvals.values()) resolver("cancel");
      active.approvals.clear();
      db.updateWorkflowRun(active.id, {
        status: "interrupted",
        error: "应用已退出，运行被中断",
        finishedAt: Date.now(),
      });
      emitEvent(active.id, null, "run_finished", {
        status: "interrupted",
        error: "应用已退出，运行被中断",
      });
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
          nodeRun.outputSummary
            ? `输出摘要：\n${nodeRun.outputSummary}`
            : "输出摘要：无",
        ].join("\n");
      });
      parts.push(`## 上游产物\n\n${blocks.filter(Boolean).join("\n\n")}`);
    }

    return parts.join("\n\n---\n\n");
  }

  async function delay(active: ActiveRun, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (active.canceled) throw new CanceledError();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return {
    start,
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
