/**
 * IPC 注册入口
 *
 * 职责：装配 AgentService，按域注册各 handler，启动自动化轮询。
 * 具体业务逻辑全部在 engine / automation / db，本目录只做「接线」。
 */

import { app, BrowserWindow } from "electron";
import { createAgentService } from "../engine/agent-service";
import {
  createWorkflowRunner,
  type WorkflowRunner,
} from "../workflow/runner";
import { createScheduler, type AutomationScheduler } from "../automation/scheduler";
import { push, setMainWindow } from "./push";
import { registerAgentHandlers } from "./handlers/agent";
import { registerSessionHandlers } from "./handlers/session";
import { registerProjectHandlers } from "./handlers/project";
import { registerSettingsHandlers } from "./handlers/settings";
import { registerDialogHandlers } from "./handlers/dialog";
import { registerFileHandlers } from "./handlers/file";
import { registerAutomationHandlers } from "./handlers/automation";
import { registerTerminalHandlers } from "./handlers/terminal";
import { registerEmployeeHandlers } from "./handlers/employee";
import { registerWorkflowHandlers } from "./handlers/workflow";
import { registerWorkflowRunHandlers } from "./handlers/workflow-run";

/** 自动化轮询器实例；由本层（装配层）持有其生命周期 */
let scheduler: AutomationScheduler | null = null;

/** 工作流运行器；应用退出时需要中断运行中的节点 */
let workflowRunner: WorkflowRunner | null = null;

/**
 * 注册全部 IPC 处理器。
 * 必须在窗口创建之后调用：push 模块需要真实窗口引用，
 * 否则所有事件推送会静默丢弃。
 */
export function initIpcHandlers(window: BrowserWindow): void {
  setMainWindow(window);

  const service = createAgentService(push);

  // 删除工作流 / 工作区前需要查询是否有活跃运行，因此运行器先于 handler 创建
  const runner = createWorkflowRunner({
    service,
    emit: (event) => push("workflow:run:event", event),
    userDataDir: app.getPath("userData"),
  });
  workflowRunner = runner;

  registerAgentHandlers(service);
  registerSessionHandlers(service);
  registerProjectHandlers(service, runner);
  registerSettingsHandlers();
  registerDialogHandlers();
  registerFileHandlers();
  registerTerminalHandlers();
  registerEmployeeHandlers();
  registerWorkflowHandlers(service, runner);
  registerWorkflowRunHandlers(runner);

  // 调度器先于 handler 创建：停止任务的 handler 需要拿到调度器实例
  scheduler = createScheduler(service);
  registerAutomationHandlers(service, scheduler);
  scheduler.start();
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
