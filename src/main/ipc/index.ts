/**
 * IPC 注册入口
 *
 * 职责：装配 AgentService，按域注册各 handler，启动自动化轮询。
 * 具体业务逻辑全部在 engine / automation / db，本目录只做「接线」。
 */

import { BrowserWindow } from "electron";
import { createAgentService } from "../engine/agent-service";
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

/** 自动化轮询器实例；由本层（装配层）持有其生命周期 */
let scheduler: AutomationScheduler | null = null;

/**
 * 注册全部 IPC 处理器。
 * 必须在窗口创建之后调用：push 模块需要真实窗口引用，
 * 否则所有事件推送会静默丢弃。
 */
export function initIpcHandlers(window: BrowserWindow): void {
  setMainWindow(window);

  const service = createAgentService(push);

  registerAgentHandlers(service);
  registerSessionHandlers(service);
  registerProjectHandlers(service);
  registerSettingsHandlers();
  registerDialogHandlers();
  registerFileHandlers();
  registerTerminalHandlers();
  registerEmployeeHandlers();
  registerWorkflowHandlers();

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
