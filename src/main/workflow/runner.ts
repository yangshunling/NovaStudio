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
import { getProvider } from "../agents/registry";
import type { AgentService } from "../engine/agent-service";
import * as db from "../db/sqlite";
import type {
  DigitalEmployee,
  SessionOptions,
  Workflow,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowNodeRunStatus,
  WorkflowRun,
  WorkflowRunEvent,
  WorkflowRunEventType,
  WorkflowRunStatus,
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
import { resolveEmployeeKnowledge } from "../knowledge/runtime";

/** 单节点输出交给下游时的摘要上限 */
const UPSTREAM_SUMMARY_LIMIT = 4000;
/** 重试等待基数：第 N 次重试等待 N × 2s */
const RETRY_BASE_MS = 2000;

class CanceledError extends Error {
  constructor() {
    super("运行已取消");
    this.name = "CanceledError";
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
  shutdown(): void;
}

export interface WorkflowRunnerDeps {
  service: AgentService;
  emit: (event: WorkflowRunEvent) => void;
  userDataDir: string;
}

export function createWorkflowRunner(deps: WorkflowRunnerDeps): WorkflowRunner {
  const activeRuns = new Map<string, ActiveRun>();

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
    if (
      [...activeRuns.values()].some(
        (active) => active.workspaceId === workspace.id,
      )
    ) {
      throw new Error("该工作区已有运行中的工作流，请等待它结束");
    }

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

    // 先确认节点选择的 Agent 已安装，再创建运行记录；
    // 否则用户会看到一条注定失败的运行记录，排查成本更高。
    await assertAgentsReady(validated.order);

    const runId = randomUUID();
    const runDir = createRunArtifactDir(workspace.cwd, workflow.id, runId);
    const now = Date.now();
    const run = db.createWorkflowRun({
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
    db.updateWorkflowRun(runId, { startedAt: now });

    for (const node of validated.order) {
      const employee = employees.get(node.config.employeeId ?? "")!;
      db.createWorkflowNodeRun({
        id: randomUUID(),
        runId,
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        employeeId: employee.id,
        employeeName: employee.name,
        agentId: node.config.agentId,
        status: "pending",
        attempt: 1,
        maxRetries:
          node.config.failureStrategy === "retry" ? node.config.maxRetries : 0,
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
    };
    activeRuns.set(runId, active);

    emitEvent(runId, null, "run_started", {
      workflowId: workflow.id,
      workflowName: workflow.name,
      workspacePath: workspace.cwd,
      artifactDir: runDir,
      nodeCount: validated.order.length,
    });

    void prepareRunFiles(active).then(() => execute(active)).catch((err) => {
      finish(active, "failed", messageOf(err));
    });

    return db.getWorkflowRun(runId)!;
  }

  /**
   * 启动前置校验：本工作流用到的每个 Agent 都必须已安装。
   *
   * Nova 不再校验自己的连接配置——各 CLI 直接使用本机配置与登录。
   */
  async function assertAgentsReady(order: WorkflowNode[]): Promise<void> {
    const agentIds = new Set<string>();
    for (const node of order) {
      if (node.config.agentId) agentIds.add(node.config.agentId);
    }

    for (const agentId of agentIds) {
      const provider = getProvider(agentId);
      if (!provider) {
        throw new Error(`节点使用的 Agent「${agentId}」不存在或未注册`);
      }
      const status = await provider.detect().catch(() => ({ installed: false }));
      if (!status.installed) {
        throw new Error(
          `Agent「${provider.manifest.displayName}」未安装或不可用。请先完成安装。`,
        );
      }
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

    const agentId = node.config.agentId;
    if (!agentId) {
      throw new Error(`节点「${node.name}」未选择执行 Agent`);
    }
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

    const runtimeWarnings: string[] = [];
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
    const prompt = buildPrompt(active, node, employee, attempt);
    // 每个节点只落两份文本：提交给 Agent 的完整请求 + Agent 最终返回
    const inputPath = join(attemptDir, "request.md");
    const outputPath = join(attemptDir, "result.md");
    await writeText(
      inputPath,
      [
        systemPrompt ? `# 系统提示词\n\n${systemPrompt}` : "",
        `# 任务输入\n\n${prompt}`,
      ]
        .filter(Boolean)
        .join("\n\n---\n\n"),
    );

    const session = db.createSession(
      agentId,
      active.workspaceId,
      active.workspacePath,
      `工作流「${active.workflow.name}」· ${node.name} · 第 ${attempt} 次`,
      null,
      "workflow",
    );
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

      if (prepared.configDir) {
        db.updateSessionConfigDir(session.id, prepared.configDir);
      }
      runtimeWarnings.push(...(prepared.warnings ?? []));

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
      const result = await deps.service.run({
        sessionId: session.id,
        prompt,
        cwd: active.workspacePath,
        opts,
        env: prepared.env,
        envRemove: prepared.envRemove,
        extraArgs: prepared.extraArgs,
        onEvent: (event) => {
          if (event.type === "text") texts.push(event.content);
          else if (event.type === "text_delta") deltas.push(event.delta);
        },
      });

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
          `Agent 退出码 ${result.exitCode}`,
          false,
          session.id,
          attemptDir,
          inputPath,
          outputPath,
        );
      }

      const output =
        texts.join("\n\n").trim() || deltas.join("").trim() || "（无文本输出）";
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
      active.currentSessionId = null;
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
  }

  function failedAttempt(
    error: string,
    canceled: boolean,
    sessionId: string,
    attemptDir: string,
    inputPath: string,
    outputPath: string,
  ): AttemptOutcome {
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
    return [...activeRuns.values()].some(
      (active) => active.workflow.id === workflowId,
    );
  }

  function hasActiveRunInWorkspace(workspaceId: string): boolean {
    return [...activeRuns.values()].some(
      (active) => active.workspaceId === workspaceId,
    );
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
      employee.description,
      employee.systemPrompt,
      knowledgeSection,
    ]
      .filter((part) => part && part.trim())
      .join("\n\n");
  }

  function buildPrompt(
    active: ActiveRun,
    node: WorkflowNode,
    employee: DigitalEmployee,
    attempt: number,
  ): string {
    const parts: string[] = [];
    parts.push(
      node.config.taskDetail.trim() ||
        `请完成节点「${node.name}」分配给你的任务。`,
    );

    const upstreamIds = active.predecessors.get(node.id) ?? [];
    if (upstreamIds.length > 0) {
      const blocks = upstreamIds.map((predecessorId) => {
        const predecessor = active.order.find(
          (item) => item.id === predecessorId,
        );
        const nodeRun = db
          .listWorkflowNodeRuns(active.id)
          .find((item) => item.nodeId === predecessorId);
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

    parts.push(
      [
        "## 输出要求",
        `你是第 ${attempt} 次尝试。完成后请输出结构化交接内容，供下一个节点使用：`,
        "",
        "## 结论",
        "## 改动文件",
        "## 关键决策",
        "## 遗留问题 / 下一步输入",
      ].join("\n"),
    );

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
    shutdown,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
