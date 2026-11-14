/**
 * IPC 注册入口
 *
 * 职责：装配 AgentService，按域注册各 handler，启动自动化轮询。
 * 具体业务逻辑全部在 engine / automation / db，本目录只做「接线」。
 */

import { BrowserWindow } from "electron";
import * as db from "../db/sqlite";
import { createAgentService, type AgentService } from "../agents/agent-service";
import {
  createWorkflowRunner,
  type WorkflowRunner,
} from "../workflow/runner";
import { createScheduler, type AutomationScheduler } from "../automation/scheduler";
import {
  createTerminalManager,
  type TerminalManager,
} from "../terminal/manager";
import {
  createTriggerScheduler,
  type TriggerScheduler,
} from "../workflow/trigger-scheduler";
import { flushEvents, getMainWindow, push, setMainWindow } from "./push";
import { registerAgentHandlers } from "./handlers/agent";
import { registerSessionHandlers } from "./handlers/session";
import { registerProjectHandlers } from "./handlers/project";
import { registerSettingsHandlers } from "./handlers/settings";
import { registerDialogHandlers } from "./handlers/dialog";
import { registerFileHandlers } from "./handlers/file";
import { registerAutomationHandlers } from "./handlers/automation";
import { registerTerminalHandlers } from "./handlers/terminal";
import { registerEmployeeHandlers } from "./handlers/employee";
import { registerMcpHandlers } from "./handlers/mcp";
import { registerSkillHandlers } from "./handlers/skill";
import { registerKnowledgeHandlers } from "./handlers/knowledge";
import { registerWorkflowHandlers } from "./handlers/workflow";
import { registerWorkflowRunHandlers } from "./handlers/workflow-run";
import { purgeStaleWorkflowSessionFiles } from "../workflow/cleanup";
import { registerTriggerHandlers } from "./handlers/trigger";
import { registerTodoHandlers } from "./handlers/todo";
import { registerReportHandlers } from "./handlers/report";
import { registerPromptHandlers } from "./handlers/prompt";
import { registerGitHandlers } from "./handlers/git";
import { registerUpdaterHandlers } from "./handlers/updater";
import { registerAppHandlers } from "./handlers/app";
import { registerUnsavedHandlers } from "./handlers/unsaved";
import { appLifecycle } from "../lifecycle";
import { shutdownUpgradeCommands } from "../agents/claude/upgrade";

/** 自动化轮询器实例；由本层（装配层）持有其生命周期 */
let scheduler: AutomationScheduler | null = null;

/** 工作流运行器；应用退出时需要中断运行中的节点 */
let workflowRunner: WorkflowRunner | null = null;

/** 定时触发器调度器 */
let triggerScheduler: TriggerScheduler | null = null;

/** Agent 服务实例；应用退出时需要中断所有运行中的会话 */
let agentService: AgentService | null = null;

/** 终端管理器；窗口关闭 / 渲染进程崩溃时需要回收全部 PTY */
let terminalManager: TerminalManager | null = null;

/** 回收全部终端进程（窗口销毁时调用） */
export function stopTerminals(): void {
  terminalManager?.stopAll();
}

/**
 * 窗口关闭 / 渲染进程崩溃：拒绝所有待处理的工具授权询问。
 *
 * 无人应答时 CLI 会一直阻塞，因此必须显式拒绝，让运行继续收尾。
 */
export function denyPendingPermissions(): void {
  attachMainWindow(null);
  agentService?.denyAllPending(
    "Nova 窗口已关闭，无法确认工具授权，已自动拒绝该工具调用。",
    "window-closed",
  );
}

/**
 * 把主进程推送绑定到窗口。
 *
 * macOS 关闭所有窗口后应用仍然存活，重新激活时会创建新窗口，
 * 此时必须重新绑定，否则所有事件推送会发往已销毁的窗口。
 */
export function attachMainWindow(window: BrowserWindow | null): void {
  setMainWindow(window);
}

/**
 * 注册全部 IPC 处理器。
 * 必须在窗口创建之后调用：push 模块需要真实窗口引用，
 * 否则所有事件推送会静默丢弃。
 */
export function initIpcHandlers(window: BrowserWindow): void {
  attachMainWindow(window);

  const service = createAgentService(push, {
    canAskUser: () => getMainWindow() !== null,
  });
  agentService = service;

  // 删除工作流 / 工作区前需要查询是否有活跃运行，因此运行器先于 handler 创建
  const runner = createWorkflowRunner({
    service,
    emit: (event) => push("workflow:run:event", event),
    emitAgentEvent: (payload) => push("workflow:run:agentEvent", payload),
    flushEvents,
    // 触发器启动的运行结束后，把结果回写到触发器卡片
    onRunFinished: (run) => {
      if (run.source !== "trigger" || !run.triggerId) return;
      const error =
        run.status === "failed" || run.status === "interrupted"
          ? run.error ?? run.status
          : null;
      const updated = db.updateWorkflowTriggerRuntime(run.triggerId, {
        lastError: error,
      });
      if (updated) push("triggers:updated", updated);
    },
  });
  workflowRunner = runner;

  /*
   * 异常退出可能在工作流会话的 CLI 目录里留下 JSONL。工作流运行详情
   * 从 messages 表回放，不需要这些文件，启动时兜底删除。
   */
  void purgeStaleWorkflowSessionFiles(service).catch((err) => {
    console.warn("[workflow] 清理遗留会话文件失败：", err);
  });

  registerAgentHandlers(service);
  registerSessionHandlers(service);
  registerProjectHandlers(service, runner);
  registerSettingsHandlers();
  registerDialogHandlers();
  registerFileHandlers();
  terminalManager = createTerminalManager(push);
  registerTerminalHandlers(terminalManager);
  registerEmployeeHandlers(service, runner);
  registerMcpHandlers();
  registerSkillHandlers();
  registerKnowledgeHandlers();
  registerWorkflowHandlers(service, runner);
  registerWorkflowRunHandlers(service, runner);
  registerTriggerHandlers();
  registerTodoHandlers();
  registerReportHandlers();
  registerPromptHandlers();
  registerGitHandlers();
  registerUpdaterHandlers();
  registerAppHandlers();
  registerUnsavedHandlers();

  // 调度器先于 handler 创建：停止任务的 handler 需要拿到调度器实例
  scheduler = createScheduler(service, { emit: push, flushEvents });
  registerAutomationHandlers(service, scheduler);
  scheduler.start();

  // 触发器调度器依赖工作流运行器；启动时会把下次触发时间重算到未来
  triggerScheduler = createTriggerScheduler({
    runner,
    emit: (trigger) => push("triggers:updated", trigger),
  });
  triggerScheduler.start();

  /*
   * 退出清理：在本层创建的资源就地登记，退出主流程不再逐个硬编码。
   * order 决定顺序 —— 先停调度与触发器，再中断运行、回收终端，
   * 最后等 Agent 收尾落库（它可能写 messages / 更新会话引用）。
   */
  appLifecycle.register({ name: "automation", order: 20, run: stopAutomation });
  appLifecycle.register({ name: "triggers", order: 30, run: stopTriggers });
  appLifecycle.register({ name: "workflows", order: 40, run: stopWorkflows });
  appLifecycle.register({ name: "terminals", order: 50, run: stopTerminals });
  appLifecycle.register({
    name: "agent-install",
    order: 70,
    run: shutdownUpgradeCommands,
  });
  appLifecycle.register({
    name: "agents",
    order: 80,
    timeoutMs: 10_000,
    run: stopAgents,
  });
}

/** 是否仍有需要保持全速运行的后台工作（聊天 / 自动化 / 工作流） */
export function hasActiveBackgroundWork(): boolean {
  return Boolean(
    agentService?.hasRunningSessions() || workflowRunner?.hasActiveRuns(),
  );
}

/** 停止后台任务（应用退出时调用，避免遗留定时器） */
export function stopAutomation(): void {
  scheduler?.stop();
  scheduler = null;
}

/** 中断所有运行中的工作流（进程即将退出，不能留下“假装还在跑”的状态） */
export function stopWorkflows(): void {
  workflowRunner?.shutdown();
  workflowRunner = null;
}

/** 停止触发器轮询（应用退出时调用） */
export function stopTriggers(): void {
  triggerScheduler?.stop();
  triggerScheduler = null;
}

/**
 * 中断聊天 / 自动化等所有运行中的 Agent 会话（应用退出时调用）。
 * 返回 Promise：调用方必须在关库前 await，保证消息落库完成。
 */
export async function stopAgents(): Promise<void> {
  const service = agentService;
  agentService = null;
  if (service) await service.shutdown();
}
