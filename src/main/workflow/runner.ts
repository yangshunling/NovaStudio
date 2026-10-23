/**
 * 工作流运行引擎（P0）
 *
 * 模型：工作流是编排器，每个节点是一次独立的数字员工执行。
 * - 严格串行：只有上一个节点成功/跳过后，下一个节点才启动
 * - 每节点独立会话；上下文只通过工作区里的产物与 handoff 传递
 * - Claude 节点使用独立 CLAUDE_CONFIG_DIR，MCP 走独立配置文件
 *
 * 运行状态全部落库，事件同时推送渲染层；渲染层断线后可重新拉取回放。
 */

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
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
  prepareClaudeEnvironment,
  removeClaudeRuntime,
  truncate,
  writeJson,
  writeText,
  type ClaudeEnvironment,
} from "./artifacts";
import { GraphValidationError, validateGraph } from "./graph";

/** 单节点输出交给下游时的摘要上限 */
const HANDOFF_SUMMARY_LIMIT = 4000;
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
  start(workflowId: string): WorkflowRun;
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

  function start(workflowId: string): WorkflowRun {
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
        agentId: employee.agentId,
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
            handoffPath: outcome.handoffPath,
            outputSummary: outcome.summary,
          });
          emitEvent(active.id, initial.id, "node_finished", {
            nodeId: node.id,
            nodeName: node.name,
            status: "succeeded",
            attempt,
            sessionId: outcome.sessionId,
            outputPath: outcome.outputPath,
            handoffPath: outcome.handoffPath,
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
    handoffPath: string;
    summary: string;
  }

  async function runAttempt(
    active: ActiveRun,
    node: WorkflowNode,
    employee: DigitalEmployee,
    attempt: number,
  ): Promise<AttemptOutcome> {
    const nodeRun = nodeRunOf(active, node.id);
    const attemptDir = join(
      active.runDir,
      "nodes",
      node.id,
      `attempt-${attempt}`,
    );
    await ensureDir(attemptDir);

    const runtimeWarnings: string[] = [];
    let claudeEnv: ClaudeEnvironment | null = null;
    if (employee.agentId === "claude") {
      claudeEnv = await prepareClaudeEnvironment({
        userDataDir: deps.userDataDir,
        runId: active.id,
        nodeId: node.id,
        attempt,
        workspacePath: active.workspacePath,
        employee,
      });
      runtimeWarnings.push(...claudeEnv.warnings);
    } else {
      // 具体物化适配器目前只有 Claude；是否给出「不支持」告警由能力声明决定，
      // 避免 UI 与运行时各自硬编码 agent id。
      const capabilities = getProvider(employee.agentId)?.manifest.capabilities;
      const enabledSkills = employee.skills.filter((skill) => skill.enabled);
      if (enabledSkills.length > 0 && !capabilities?.skills) {
        runtimeWarnings.push(
          `当前 Agent（${employee.agentId}）暂未实现技能注入，本次已忽略 ${enabledSkills.length} 个技能。`,
        );
      }
      const enabledMcp = employee.mcpServers.filter((server) => server.enabled);
      if (enabledMcp.length > 0 && !capabilities?.mcp) {
        runtimeWarnings.push(
          `当前 Agent（${employee.agentId}）暂未实现 MCP 注入，本次已忽略 ${enabledMcp.length} 个 MCP 服务。`,
        );
      }
    }
    if (runtimeWarnings.length > 0) {
      await writeText(
        join(attemptDir, "warnings.txt"),
        runtimeWarnings.join("\n"),
      );
    }

    const prompt = buildPrompt(active, node, employee, attempt);
    const inputPath = join(attemptDir, "input.md");
    const outputPath = join(attemptDir, "output.md");
    const handoffPath = join(attemptDir, "handoff.md");
    await writeText(inputPath, prompt);

    const session = db.createSession(
      employee.agentId,
      active.workspaceId,
      active.workspacePath,
      `工作流「${active.workflow.name}」· ${node.name} · 第 ${attempt} 次`,
      claudeEnv?.configDir ?? null,
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

    const texts: string[] = [];
    const deltas: string[] = [];
    const opts: SessionOptions = {};
    if (employee.model) opts.model = employee.model;
    const systemPrompt = buildSystemPrompt(employee);
    if (systemPrompt) opts.systemPrompt = systemPrompt;
    if (employee.agentId === "claude" && claudeEnv?.mcpConfigPath) {
      opts.mcpConfig = claudeEnv.mcpConfigPath;
      opts.strictMcpConfig = "1";
    }

    // 把「到底提交了什么」落成文件，运行详情里可以直接查看/审计
    await writeText(
      join(attemptDir, "system-prompt.md"),
      systemPrompt || "（未设置系统提示词）",
    );
    await writeText(
      join(attemptDir, "agent-options.json"),
      JSON.stringify(
        {
          agentId: employee.agentId,
          model: employee.model || null,
          mcpConfig: claudeEnv?.mcpConfigPath ? "mcp.json" : null,
          strictMcpConfig: opts.strictMcpConfig === "1",
          isolatedConfigDir: !!claudeEnv?.configDir,
          mcpServers: claudeEnv?.mcpServers ?? [],
          skills: claudeEnv?.skills ?? [],
        },
        null,
        2,
      ),
    );

    try {
      const result = await deps.service.run({
        sessionId: session.id,
        prompt,
        cwd: active.workspacePath,
        opts,
        env: claudeEnv?.env,
        onEvent: (event) => {
          if (event.type === "text") texts.push(event.content);
          else if (event.type === "text_delta") deltas.push(event.delta);
        },
      });

      if (active.canceled) {
        return failedAttempt("运行已取消", true, session.id, attemptDir, inputPath, outputPath, handoffPath);
      }
      if (result.aborted) {
        return failedAttempt("运行被中断", true, session.id, attemptDir, inputPath, outputPath, handoffPath);
      }
      if (!result.ok) {
        return failedAttempt(result.error ?? "Agent 启动失败", false, session.id, attemptDir, inputPath, outputPath, handoffPath);
      }
      if (result.exitCode !== 0) {
        return failedAttempt(
          `Agent 退出码 ${result.exitCode}`,
          false,
          session.id,
          attemptDir,
          inputPath,
          outputPath,
          handoffPath,
        );
      }

      const output =
        texts.join("\n\n").trim() || deltas.join("").trim() || "（无文本输出）";
      await writeText(outputPath, output);
      await writeText(
        handoffPath,
        [
          `# ${node.name}`,
          "",
          `- 执行者：${employee.name}`,
          `- 结束时间：${new Date().toISOString()}`,
          "",
          "## 产出",
          "",
          output,
        ].join("\n"),
      );

      return {
        ok: true,
        error: "",
        sessionId: session.id,
        attemptDir,
        inputPath,
        outputPath,
        handoffPath,
        summary: truncate(output, HANDOFF_SUMMARY_LIMIT),
      };
    } finally {
      active.currentSessionId = null;
      await removeClaudeRuntime(claudeEnv?.runtimeDir ?? null);
    }
  }

  function failedAttempt(
    error: string,
    canceled: boolean,
    sessionId: string,
    attemptDir: string,
    inputPath: string,
    outputPath: string,
    handoffPath: string,
  ): AttemptOutcome {
    return {
      ok: false,
      canceled,
      error,
      sessionId,
      attemptDir,
      inputPath,
      outputPath,
      handoffPath,
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

  function buildSystemPrompt(employee: DigitalEmployee): string {
    return [
      employee.role
        ? `你是「${employee.name}」，职位：${employee.role}。`
        : `你是「${employee.name}」。`,
      employee.description,
      employee.systemPrompt,
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
        const handoff = nodeRun.handoffPath
          ? `交接单：${nodeRun.handoffPath}`
          : "交接单：无";
        return [
          `### 上游节点：${predecessor?.name ?? predecessorId}`,
          `状态：${nodeRun.status}`,
          handoff,
          nodeRun.outputSummary
            ? `摘要：\n${nodeRun.outputSummary}`
            : "摘要：无",
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
