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
import type { AgentAuthMode, AgentSettingsDraft } from "@shared/contracts/agent";
import type { WeeklyReportOptions } from "@shared/report";
import type {
  AppSettings,
  DigitalEmployeeDraft,
  InputImage,
  McpServerDraft,
  PromptDraft,
  SkillImportKind,
  TodoDraft,
  WorkflowDraft,
  WorkflowTriggerDraft,
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
  openAgentConfigDir: (agentId: string) =>
    call("agent:openConfigDir", { agentId }),
  getAgentSettings: (agentId: string) =>
    call("agent:settings:get", { agentId }),
  saveAgentSettings: (draft: AgentSettingsDraft) =>
    call("agent:settings:save", { draft }),
  listAgentModels: (input: {
    agentId: string;
    baseUrl: string;
    apiKey: string;
    authMode?: AgentAuthMode;
    customHeaders?: string;
  }) => call("agent:models:list", input),
  checkAgentUpgrade: (agentId: string) =>
    call("agent:upgrade:check", { agentId }),
  upgradeAgent: (agentId: string) => call("agent:upgrade:run", { agentId }),
  sendAgent: (
    sessionId: string,
    prompt: string,
    employeeId?: string | null,
    images?: InputImage[],
  ): Promise<SendAgentResult> =>
    call("agent:send", { sessionId, prompt, images, employeeId }),
  abortAgent: (sessionId: string) => call("agent:abort", { sessionId }),

  // === 项目 ===
  listProjects: () => call("project:list"),
  createProject: (name: string, cwd: string) => call("project:create", { name, cwd }),
  deleteProject: (id: string) => call("project:delete", { id }),
  revealProject: (id: string) => call("project:reveal", { id }),
  listFiles: (projectId: string, subPath?: string) =>
    call("project:listFiles", { projectId, subPath }),
  getGitStatus: (projectId: string) => call("project:gitStatus", { projectId }),
  getGitStatusDetail: (projectId: string) =>
    call("git:statusDetail", { projectId }),
  listGitBranches: (projectId: string) => call("git:branches", { projectId }),
  listGitLog: (projectId: string, limit?: number) =>
    call("git:log", { projectId, limit }),
  listGitCommitFiles: (projectId: string, hash: string) =>
    call("git:commitFiles", { projectId, hash }),
  getGitDiff: (projectId: string, relativePath: string, staged: boolean) =>
    call("git:diff", { projectId, relativePath, staged }),
  getGitCommitFileDiff: (
    projectId: string,
    hash: string,
    relativePath: string,
    oldPath?: string,
  ) =>
    call("git:commitFileDiff", { projectId, hash, relativePath, oldPath }),
  stageGitPaths: (projectId: string, paths: string[]) =>
    call("git:stage", { projectId, paths }),
  unstageGitPaths: (projectId: string, paths: string[]) =>
    call("git:unstage", { projectId, paths }),
  commitGit: (projectId: string, message: string) =>
    call("git:commit", { projectId, message }),
  generateGitCommitMessage: (projectId: string) =>
    call("git:generateCommitMessage", { projectId }),
  checkoutGitBranch: (projectId: string, branch: string) =>
    call("git:checkoutBranch", { projectId, branch }),
  createGitBranch: (projectId: string, name: string) =>
    call("git:createBranch", { projectId, name }),
  initGitRepository: (projectId: string) =>
    call("git:init", { projectId }),
  pushGitBranch: (projectId: string, branch: string) =>
    call("git:push", { projectId, branch }),
  pullGitBranch: (projectId: string) =>
    call("git:pull", { projectId }),
  discardGitPaths: (projectId: string, paths: string[]) =>
    call("git:discard", { projectId, paths }),
  continueGitOperation: (projectId: string) =>
    call("git:continueOperation", { projectId }),
  abortGitOperation: (projectId: string) =>
    call("git:abortOperation", { projectId }),
  readFile: (projectId: string, relativePath: string) =>
    call("file:read", { projectId, relativePath }),
  readEmbeddedImage: (projectId: string, markdownPath: string, src: string) =>
    call("file:readEmbeddedImage", { projectId, markdownPath, src }),
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
  createSession: (
    projectId: string | null,
    agentId: string,
    employeeId?: string | null,
    permissionMode?: string | null,
  ) =>
    call("session:create", {
      projectId,
      agentId,
      employeeId,
      permissionMode,
    }),
  setSessionEmployee: (sessionId: string, employeeId: string | null) =>
    call("session:setEmployee", { sessionId, employeeId }),
  setSessionPermissionMode: (sessionId: string, permissionMode: string) =>
    call("session:setPermissionMode", { sessionId, permissionMode }),
  listSessions: () => call("session:list"),
  getDefaultCwd: () => call("session:defaultCwd"),
  getSession: (
    id: string,
    options?: { limit?: number; before?: number; beforeId?: string },
  ) => call("session:get", { id, ...options }),
  renameSession: (id: string, title: string) => call("session:rename", { id, title }),
  deleteSession: (id: string) => call("session:delete", { id }),
  setSessionPinned: (id: string, pinned: boolean) =>
    call("session:setPinned", { id, pinned }),
  setSessionProject: (sessionId: string, projectId: string | null) =>
    call("session:setProject", { sessionId, projectId }),

  // === 原生对话框 ===
  pickDirectory: () => call("dialog:pickDirectory"),

  // === 设置 ===
  getSettings: () => call("settings:get"),
  setSettings: (patch: Partial<AppSettings>) => call("settings:set", patch),
  setWindowAppearance: (appearance: "light" | "dark") =>
    call("window:setAppearance", { appearance }),

  // === 应用信息 / 更新 ===
  getAppInfo: () => call("app:info"),
  getUpdaterState: () => call("updater:state"),
  checkForUpdates: () => call("updater:check"),
  downloadUpdate: () => call("updater:download"),
  installUpdate: () => call("updater:install"),

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
  deleteEmployee: (id: string, force?: boolean) =>
    call("employees:delete", { id, force }),

  // === MCP 资产 ===
  listMcpServers: () => call("mcp:list"),
  createMcpServer: (draft: McpServerDraft) => call("mcp:create", { draft }),
  updateMcpServer: (id: string, draft: McpServerDraft) =>
    call("mcp:update", { id, draft }),
  saveMcpDefinition: (id: string | null, name: string, definition: string) =>
    call("mcp:saveDefinition", { id, name, definition }),
  deleteMcpServer: (id: string) => call("mcp:delete", { id }),
  importMcpServers: (json: string) => call("mcp:import", { json }),
  importMcpFile: () => call("mcp:importFile"),
  revealMcpServer: (id: string) => call("mcp:reveal", { id }),

  // === 技能资产 ===
  listSkills: () => call("skills:list"),
  importSkills: (kind: SkillImportKind) => call("skills:import", { kind }),
  deleteSkill: (id: string) => call("skills:delete", { id }),
  listSkillFiles: (id: string) => call("skills:listFiles", { id }),
  readSkillFile: (id: string, relativePath: string) =>
    call("skills:readFile", { id, relativePath }),
  writeSkillFile: (id: string, relativePath: string, content: string) =>
    call("skills:writeFile", { id, relativePath, content }),
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
  writeKnowledgeDocument: (id: string, relativePath: string, content: string) =>
    call("knowledge:writeDocument", { id, relativePath, content }),
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
  listActiveWorkflowRuns: () => call("workflow:run:listActive"),
  resumeWorkflowRun: (runId: string, nodeRunId?: string) =>
    call("workflow:run:resume", { runId, nodeRunId }),
  deleteWorkflowRun: (runId: string) =>
    call("workflow:run:delete", { runId }),
  cancelWorkflowRun: (runId: string) =>
    call("workflow:run:cancel", { runId }),
  approveWorkflowNode: (
    runId: string,
    nodeRunId: string,
    action: "approve" | "reject" | "revise",
    note?: string,
  ) => call("workflow:run:approve", { runId, nodeRunId, action, note }),
  openWorkflowArtifacts: (runId: string) =>
    call("workflow:run:openArtifacts", { runId }),
  getWorkflowNodeDetail: (runId: string, nodeRunId: string) =>
    call("workflow:run:nodeDetail", { runId, nodeRunId }),
  openWorkflowNodeArtifacts: (runId: string, nodeRunId: string) =>
    call("workflow:run:openNodeArtifacts", { runId, nodeRunId }),
  openWorkflowNodeFile: (
    runId: string,
    nodeRunId: string,
    relativePath: string,
  ) =>
    call("workflow:run:openNodeFile", { runId, nodeRunId, relativePath }),
  readWorkflowNodeFile: (
    runId: string,
    nodeRunId: string,
    relativePath: string,
  ) =>
    call("workflow:run:readNodeFile", { runId, nodeRunId, relativePath }),

  // === 工作流触发器 ===
  listTriggers: () => call("triggers:list"),
  createTrigger: (draft: WorkflowTriggerDraft) =>
    call("triggers:create", { draft }),
  updateTrigger: (id: string, draft: WorkflowTriggerDraft) =>
    call("triggers:update", { id, draft }),
  deleteTrigger: (id: string) => call("triggers:delete", { id }),
  listTriggerBindings: () => call("triggers:bindings"),
  listWorkflowTriggerIds: (workflowId: string) =>
    call("triggers:bindingsForWorkflow", { workflowId }),
  setWorkflowTriggers: (workflowId: string, triggerIds: string[]) =>
    call("triggers:setForWorkflow", { workflowId, triggerIds }),

  // === 待办事项 ===
  listTodos: () => call("todos:list"),
  createTodo: (draft: TodoDraft) => call("todos:create", { draft }),
  updateTodo: (id: string, draft: TodoDraft) =>
    call("todos:update", { id, draft }),
  toggleTodo: (id: string, done: boolean) =>
    call("todos:toggle", { id, done }),
  deleteTodo: (id: string) => call("todos:delete", { id }),
  clearCompletedTodos: () => call("todos:clearCompleted"),
  reorderTodos: (ids: string[]) => call("todos:reorder", { ids }),

  // === 周报 ===
  generateWeeklyReport: (
    requestId: string,
    start: number,
    end: number,
    options: WeeklyReportOptions,
  ) => call("report:generate", { requestId, start, end, options }),
  abortWeeklyReport: (requestId: string) =>
    call("report:abort", { requestId }),
  exportReport: (content: string, defaultName: string) =>
    call("report:export", { content, defaultName }),

  // === 常用提示词 ===
  listPrompts: () => call("prompts:list"),
  createPrompt: (draft: PromptDraft) => call("prompts:create", { draft }),
  updatePrompt: (id: string, draft: PromptDraft) =>
    call("prompts:update", { id, draft }),
  deletePrompt: (id: string) => call("prompts:delete", { id }),

  // === 主进程推送订阅（返回取消订阅函数） ===
  on: {
    agentEvent: (cb: (payload: IpcPushMap["agent:event"]) => void) =>
      on("agent:event", cb),
    agentDone: (cb: (payload: IpcPushMap["agent:done"]) => void) => on("agent:done", cb),
    agentAborted: (cb: (payload: IpcPushMap["agent:aborted"]) => void) =>
      on("agent:aborted", cb),
    agentsDetected: (cb: (payload: IpcPushMap["agents:detected"]) => void) =>
      on("agents:detected", cb),
    agentUpgradeProgress: (
      cb: (payload: IpcPushMap["agent:upgrade:progress"]) => void,
    ) => on("agent:upgrade:progress", cb),
    automationUpdated: (cb: (payload: IpcPushMap["automation:updated"]) => void) =>
      on("automation:updated", cb),
    terminalData: (cb: (payload: IpcPushMap["terminal:data"]) => void) =>
      on("terminal:data", cb),
    terminalExit: (cb: (payload: IpcPushMap["terminal:exit"]) => void) =>
      on("terminal:exit", cb),
    workflowRunEvent: (
      cb: (payload: IpcPushMap["workflow:run:event"]) => void,
    ) => on("workflow:run:event", cb),
    workflowRunAgentEvent: (
      cb: (payload: IpcPushMap["workflow:run:agentEvent"]) => void,
    ) => on("workflow:run:agentEvent", cb),
    triggersUpdated: (cb: (payload: IpcPushMap["triggers:updated"]) => void) =>
      on("triggers:updated", cb),
    todosChanged: (cb: (payload: IpcPushMap["todos:changed"]) => void) =>
      on("todos:changed", cb),
    reportChunk: (cb: (payload: IpcPushMap["report:chunk"]) => void) =>
      on("report:chunk", cb),
    updaterChanged: (cb: (payload: IpcPushMap["updater:changed"]) => void) =>
      on("updater:changed", cb),
  },
};
