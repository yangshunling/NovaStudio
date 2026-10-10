/**
 * IPC 契约层
 *
 * 唯一的通道定义来源。preload 与主进程 handler 都从这里取参数/返回类型，
 * 任何一方改了通道名或参数形状，另一方立即编译报错 —— 杜绝字符串字面量漂移。
 */

import type {
  AgentEvent,
  AppSettings,
  AutomationTask,
  FileEntry,
  GitStatusSummary,
  OpenFileExternalResult,
  Project,
  ReadFileResult,
  Session,
  SessionOptions,
} from "../types";
import type { AgentInfo } from "./agent";

/** agent:send 的返回：显式区分成功与业务失败 */
export type SendAgentResult =
  | { ok: true; exitCode: number; duration: number }
  | { ok: false; error: string };

/**
 * 渲染进程 → 主进程（invoke）通道表。
 * args 为元组，与 ipcRenderer.invoke(channel, ...args) 一一对应。
 */
export interface IpcInvokeMap {
  /** 检测本机已安装的 Agent */
  "agent:detect": { args: []; result: AgentInfo[] };
  /** 统一发送：主进程按会话是否已有会话引用决定新建 / 恢复 */
  "agent:send": {
    args: [{ sessionId: string; prompt: string; opts?: SessionOptions }];
    result: SendAgentResult;
  };
  /** 中断指定会话（多会话并发时互不影响） */
  "agent:abort": { args: [{ sessionId: string }]; result: boolean };

  "project:list": { args: []; result: Project[] };
  "project:create": { args: [{ name: string; cwd: string }]; result: Project };
  "project:delete": { args: [{ id: string }]; result: boolean };
  /** 列出项目目录下的文件，供 @ 提及选择 */
  "project:listFiles": {
    args: [{ cwd: string; subPath?: string }];
    result: FileEntry[];
  };
  /** 读取当前项目的 Git 状态，供文件树显示新增 / 修改 / 删除等标记 */
  "project:gitStatus": {
    args: [{ cwd: string }];
    result: GitStatusSummary;
  };
  /** 读取项目内文件，供中间区域只读预览 */
  "file:read": {
    args: [{ projectId: string; relativePath: string }];
    result: ReadFileResult;
  };
  /** 使用系统默认程序打开项目内文件 */
  "file:openExternal": {
    args: [{ projectId: string; relativePath: string }];
    result: OpenFileExternalResult;
  };

  /** 预创建空会话，拿到 sessionId 后再 agent:send，事件才能按会话路由 */
  "session:create": { args: [{ projectId: string; agentId: string }]; result: Session };
  "session:list": { args: []; result: Session[] };
  /** 返回带历史消息的会话；历史由 provider 回放 */
  "session:get": { args: [{ id: string }]; result: Session | null };
  "session:rename": { args: [{ id: string; title: string }]; result: boolean };
  "session:delete": { args: [{ id: string }]; result: boolean };
  /** 清空某项目下的全部会话（含每个会话在 CLI 侧的数据） */
  "session:clearProject": { args: [{ projectId: string }]; result: boolean };

  /** 原生目录选择器 */
  "dialog:pickDirectory": { args: []; result: string | null };

  "settings:get": { args: []; result: Partial<AppSettings> };
  "settings:set": { args: [Partial<AppSettings>]; result: boolean };

  "automation:list": { args: []; result: AutomationTask[] };
  "automation:create": {
    args: [{ prompt: string; projectId: string; agentId: string }];
    result: AutomationTask;
  };
  "automation:delete": { args: [{ id: string }]; result: boolean };
  "automation:retry": { args: [{ id: string }]; result: boolean };
  /** 手动停止一个执行中的任务 */
  "automation:stop": { args: [{ id: string }]; result: boolean };
}

/** 主进程 → 渲染进程（push）通道表。事件均带 sessionId，供多会话并发路由。 */
export interface IpcPushMap {
  "agent:event": { sessionId: string; event: AgentEvent };
  "agent:done": { sessionId: string; exitCode: number; duration: number };
  "agents:detected": AgentInfo[];
  /** 自动化任务状态变更（轮询器拾取 / 完成 / 失败时触发） */
  "automation:updated": AutomationTask;
}

export type IpcInvokeChannel = keyof IpcInvokeMap;
export type IpcPushChannel = keyof IpcPushMap;

/** 通道参数元组 */
export type IpcArgs<C extends IpcInvokeChannel> = IpcInvokeMap[C]["args"];
/** 通道返回值 */
export type IpcResult<C extends IpcInvokeChannel> = IpcInvokeMap[C]["result"];
