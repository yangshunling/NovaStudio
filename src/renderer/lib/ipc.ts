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
import type {
  AppSettings,
  DigitalEmployeeDraft,
  McpServerDraft,
  SessionOptions,
  SkillImportKind,
  WorkflowDraft,
} from "@shared/types";

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
  listAgentModels: (agentId: string) => call("agent:models", { agentId }),
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

  // === 系统终端 ===
  createTerminal: (id: string, cwd?: string, cols?: number, rows?: number) =>
    call("terminal:create", { id, cwd, cols, rows }),
  writeTerminal: (id: string, data: string) =>
    call("terminal:write", { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    call("terminal:resize", { id, cols, rows }),
  killTerminal: (id: string) => call("terminal:kill", { id }),

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
  setWindowAppearance: (appearance: "light" | "dark") =>
    call("window:setAppearance", { appearance }),

  // === 自动化任务 ===
  listAutomationTasks: () => call("automation:list"),
  createAutomationTask: (prompt: string, projectId: string, agentId: string) =>
    call("automation:create", { prompt, projectId, agentId }),
  deleteAutomationTask: (id: string) => call("automation:delete", { id }),
  retryAutomationTask: (id: string) => call("automation:retry", { id }),
  stopAutomationTask: (id: string) => call("automation:stop", { id }),

  // === 数字员工 ===
  listEmployees: () => call("employees:list"),
  createEmployee: (draft: DigitalEmployeeDraft) =>
    call("employees:create", { draft }),
  updateEmployee: (id: string, draft: DigitalEmployeeDraft) =>
    call("employees:update", { id, draft }),
  deleteEmployee: (id: string) => call("employees:delete", { id }),

  // === MCP 资产 ===
  listMcpServers: () => call("mcp:list"),
  createMcpServer: (draft: McpServerDraft) => call("mcp:create", { draft }),
  updateMcpServer: (id: string, draft: McpServerDraft) =>
    call("mcp:update", { id, draft }),
  deleteMcpServer: (id: string) => call("mcp:delete", { id }),
  importMcpServers: (json: string) => call("mcp:import", { json }),
  importMcpFile: () => call("mcp:importFile"),
  revealMcpServer: (id: string) => call("mcp:reveal", { id }),

  // === 技能资产 ===
  listSkills: () => call("skills:list"),
  importSkills: (kind: SkillImportKind) => call("skills:import", { kind }),
  deleteSkill: (id: string) => call("skills:delete", { id }),
  getSkillDocument: (id: string) => call("skills:getDocument", { id }),
  saveSkillDocument: (id: string, content: string) =>
    call("skills:saveDocument", { id, content }),
  revealSkill: (id: string) => call("skills:reveal", { id }),

  // === 知识库 ===
  listKnowledgeBases: () => call("knowledge:list"),
  createKnowledgeBase: (name: string, description: string) =>
    call("knowledge:create", { name, description }),
  updateKnowledgeBase: (id: string, name: string, description: string) =>
    call("knowledge:update", { id, name, description }),
  deleteKnowledgeBase: (id: string) => call("knowledge:delete", { id }),
  listKnowledgeDocuments: (id: string, subPath?: string) =>
    call("knowledge:listDocuments", { id, subPath }),
  createKnowledgeFolder: (id: string, parentPath: string, name: string) =>
    call("knowledge:createFolder", { id, parentPath, name }),
  uploadKnowledgeDocuments: (id: string, parentPath: string) =>
    call("knowledge:upload", { id, parentPath }),
  deleteKnowledgeDocuments: (id: string, paths: string[]) =>
    call("knowledge:deleteDocuments", { id, paths }),
  searchKnowledge: (query: string, kbId?: string) =>
    call("knowledge:search", { query, kbId }),
  readKnowledgeDocument: (id: string, relativePath: string) =>
    call("knowledge:readDocument", { id, relativePath }),
  revealKnowledgeBase: (id: string) => call("knowledge:reveal", { id }),
  openKnowledgeDocument: (id: string, relativePath: string) =>
    call("knowledge:openDocument", { id, relativePath }),

  // === 工作流 ===
  listWorkflows: () => call("workflows:list"),
  getWorkflow: (id: string) => call("workflows:get", { id }),
  createWorkflow: (draft: WorkflowDraft) => call("workflows:create", { draft }),
  updateWorkflow: (id: string, draft: WorkflowDraft) =>
    call("workflows:update", { id, draft }),
  deleteWorkflow: (id: string) => call("workflows:delete", { id }),

  // === 工作流运行 ===
  startWorkflowRun: (workflowId: string) =>
    call("workflow:run:start", { workflowId }),
  getWorkflowRun: (runId: string) => call("workflow:run:get", { runId }),
  listWorkflowRuns: (workflowId: string) =>
    call("workflow:run:list", { workflowId }),
  listWorkspaceRuns: (workspaceId: string) =>
    call("workflow:run:listByWorkspace", { workspaceId }),
  cancelWorkflowRun: (runId: string) =>
    call("workflow:run:cancel", { runId }),
  approveWorkflowNode: (
    runId: string,
    nodeRunId: string,
    action: "approve" | "reject",
    note?: string,
  ) => call("workflow:run:approve", { runId, nodeRunId, action, note }),
  openWorkflowArtifacts: (runId: string) =>
    call("workflow:run:openArtifacts", { runId }),
  getWorkflowNodeDetail: (runId: string, nodeRunId: string) =>
    call("workflow:run:nodeDetail", { runId, nodeRunId }),
  openWorkflowNodeArtifacts: (runId: string, nodeRunId: string) =>
    call("workflow:run:openNodeArtifacts", { runId, nodeRunId }),

  // === 主进程推送订阅（返回取消订阅函数） ===
  on: {
    agentEvent: (cb: (payload: IpcPushMap["agent:event"]) => void) =>
      on("agent:event", cb),
    agentDone: (cb: (payload: IpcPushMap["agent:done"]) => void) => on("agent:done", cb),
    agentsDetected: (cb: (payload: IpcPushMap["agents:detected"]) => void) =>
      on("agents:detected", cb),
    automationUpdated: (cb: (payload: IpcPushMap["automation:updated"]) => void) =>
      on("automation:updated", cb),
    terminalData: (cb: (payload: IpcPushMap["terminal:data"]) => void) =>
      on("terminal:data", cb),
    terminalExit: (cb: (payload: IpcPushMap["terminal:exit"]) => void) =>
      on("terminal:exit", cb),
    workflowRunEvent: (
      cb: (payload: IpcPushMap["workflow:run:event"]) => void,
    ) => on("workflow:run:event", cb),
  },
};
