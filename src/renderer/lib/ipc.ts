/**
 * 渲染进程 IPC 客户端
 *
 * 方法名面向调用方，参数与返回值类型全部从 shared/contracts/ipc.ts 推导。
 * 通道改名或参数变化会在编译期暴露，不会出现「类型定义与实现各写一份」的静默漂移。
 */

import type {
  IpcArgs,
  IpcInvokeChannel,
  IpcPushChannel,
  IpcPushMap,
  IpcResult,
  SendAgentResult,
} from "@shared/contracts/ipc";
import type { AppSettings, SessionOptions } from "@shared/types";

/** preload 暴露的桥（运行时结构，类型在下面统一收敛） */
interface NovaBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  subscribe: (channel: string, callback: (payload: unknown) => void) => () => void;
}

const bridge = (window as unknown as { nova: NovaBridge }).nova;

/** 唯一的类型收敛点：调用方拿到的类型由通道契约决定 */
function call<C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> {
  return bridge.invoke(channel, ...args) as Promise<IpcResult<C>>;
}

function on<C extends IpcPushChannel>(
  channel: C,
  callback: (payload: IpcPushMap[C]) => void,
): () => void {
  return bridge.subscribe(channel, callback as (payload: unknown) => void);
}

export const ipc = {
  // === Agent ===
  detectAgents: () => call("agent:detect"),
  sendAgent: (
    sessionId: string,
    prompt: string,
    opts?: SessionOptions,
  ): Promise<SendAgentResult> => call("agent:send", { sessionId, prompt, opts }),
  abortAgent: (sessionId: string) => call("agent:abort", { sessionId }),

  // === 项目 ===
  listProjects: () => call("project:list"),
  createProject: (name: string, cwd: string) => call("project:create", { name, cwd }),
  deleteProject: (id: string) => call("project:delete", { id }),
  listFiles: (cwd: string, subPath?: string) =>
    call("project:listFiles", { cwd, subPath }),
  getGitStatus: (cwd: string) => call("project:gitStatus", { cwd }),
  readFile: (projectId: string, relativePath: string) =>
    call("file:read", { projectId, relativePath }),
  openFileExternal: (projectId: string, relativePath: string) =>
    call("file:openExternal", { projectId, relativePath }),

  // === 会话 ===
  createSession: (projectId: string, agentId: string) =>
    call("session:create", { projectId, agentId }),
  listSessions: () => call("session:list"),
  getSession: (id: string) => call("session:get", { id }),
  renameSession: (id: string, title: string) => call("session:rename", { id, title }),
  deleteSession: (id: string) => call("session:delete", { id }),
  clearProjectSessions: (projectId: string) => call("session:clearProject", { projectId }),

  // === 原生对话框 ===
  pickDirectory: () => call("dialog:pickDirectory"),

  // === 设置 ===
  getSettings: () => call("settings:get"),
  setSettings: (patch: Partial<AppSettings>) => call("settings:set", patch),

  // === 自动化任务 ===
  listAutomationTasks: () => call("automation:list"),
  createAutomationTask: (prompt: string, projectId: string, agentId: string) =>
    call("automation:create", { prompt, projectId, agentId }),
  deleteAutomationTask: (id: string) => call("automation:delete", { id }),
  retryAutomationTask: (id: string) => call("automation:retry", { id }),
  stopAutomationTask: (id: string) => call("automation:stop", { id }),

  // === 主进程推送订阅（返回取消订阅函数） ===
  on: {
    agentEvent: (cb: (payload: IpcPushMap["agent:event"]) => void) =>
      on("agent:event", cb),
    agentDone: (cb: (payload: IpcPushMap["agent:done"]) => void) => on("agent:done", cb),
    agentsDetected: (cb: (payload: IpcPushMap["agents:detected"]) => void) =>
      on("agents:detected", cb),
    automationUpdated: (cb: (payload: IpcPushMap["automation:updated"]) => void) =>
      on("automation:updated", cb),
  },
};
