# 04 IPC 契约参考

## 1. 设计原则

- **唯一真相来源**：`src/shared/contracts/ipc.ts` 定义所有通道、参数元组与返回值类型。
- **三处消费**：
  1. 主进程 `handle()` 注册；
  2. preload 的 `invoke` / `subscribe`；
  3. 渲染层 `ipc` 客户端。
- **编译期约束**：任何一方改通道名或参数形状，另外两方立即报错。
- **通道命名**：`<域>:<动作>`，域与目录 / 业务模块对应。
- **参数形式**：invoke 统一“一个对象参数”（少数无参通道为空元组），避免位置参数漂移。
- **推送**：主进程 → 渲染进程，统一通过 `IpcPushMap`。

### 1.1 类型推导

```ts
export type IpcInvokeChannel = keyof IpcInvokeMap;
export type IpcPushChannel = keyof IpcPushMap;
export type IpcArgs<C extends IpcInvokeChannel> = IpcInvokeMap[C]["args"];
export type IpcResult<C extends IpcInvokeChannel> = IpcInvokeMap[C]["result"];
```

### 1.2 preload 桥

```ts
const api = { invoke, subscribe, getPathForFile };
contextBridge.exposeInMainWorld("nova", api);
```

- `invoke(channel, ...args)` → `ipcRenderer.invoke`；
- `subscribe(channel, callback)` → `ipcRenderer.on`，返回取消订阅函数；
- `getPathForFile(file)` → `webUtils.getPathForFile`，用于拖入文件时取真实路径（Electron 32 起 `File.path` 已移除）。

### 1.3 主进程注册

```ts
export function handle<C extends IpcInvokeChannel>(channel: C, handler: Handler<C>) {
  ipcMain.handle(channel, (_event, ...args) => handler(...args));
}
```

**错误约定**：handler 抛错 → `ipcRenderer.invoke` reject。渲染层用 `try/catch` 捕获，不要把业务失败包装成 `{ok:false}`（只有本来就返回联合类型的通道例外，如 `agent:send`）。

---

## 2. 推送通道（主进程 → 渲染进程）

| 通道 | payload | 说明 | 聚合 |
|---|---|---|---|
| `agent:event` | `{ sessionId, event: AgentEvent }` | 聊天流式事件 | 16ms |
| `agent:done` | `{ sessionId, exitCode, duration }` | 一轮聊天结束 | 立即 |
| `agent:aborted` | `{ sessionId }` | 被中断的运行已真正收尾（不触发“完成”语义） | 立即 |
| `agent:permission:request` | `PermissionPromptView` | 工具授权询问（必须即时送达） | 立即 |
| `agent:permission:resolved` | `PermissionPromptResolved` | 授权请求已失效（已回答 / 超时 / 中断） | 立即 |
| `agents:detected` | `AgentInfo[]` | Agent 检测结果 | 立即 |
| `agent:upgrade:progress` | `{ agentId, chunk }` | 升级过程文本（已去除控制序列） | 立即 |
| `automation:updated` | `AutomationTask` | 任务状态变更 | 立即 |
| `terminal:data` | `{ id, data }` | PTY 输出 | 立即 |
| `terminal:exit` | `{ id, exitCode, signal? }` | PTY 退出 | 立即 |
| `workflow:run:event` | `WorkflowRunEvent` | 运行状态事件（已落库） | 立即 |
| `workflow:run:agentEvent` | `{ runId, nodeRunId, attempt, round, seq, event }` | 节点实时对话（不落库） | 16ms |
| `triggers:updated` | `WorkflowTrigger` | 触发器状态变更 | 立即 |
| `todos:changed` | `{ pending: number }` | 待办增删改后推送未完成数量 | 立即 |
| `workspace:changed` | `{ projectId, dirs: string[] }` | 已监听目录内有文件变化 | 立即 |
| `report:chunk` | `{ requestId, chunk }` | 周报生成增量文本 | 立即 |
| `updater:changed` | `UpdaterState` | 更新状态 | 立即 |

### 2.1 批量聚合

`src/main/ipc/push.ts`：

```ts
const BATCH_WINDOWS = {
  "agent:event": 16,
  "workflow:run:agentEvent": 16,
};
```

- 在表里的通道进入 `createBatchQueue(16ms)`；
- 其余通道立即 `webContents.send`；
- `flushEvents()` 在运行结束 / 中断 / 状态事件前调用，保证顺序。

**为什么状态事件前要 flush**：节点 token 走批量，`node_finished` 立即发送；不 flush 会让渲染层先看到“节点完成”，再收到最后一批 token。

---

## 3. invoke 通道总表

> 共 139 个 invoke 通道、17 个 push 通道。下表按业务域分组。参数列写对象形状；无参写 `—`。

### 3.1 Agent（11）

| 通道 | 参数 | 返回 |
|---|---|---|
| `agent:detect` | — | `AgentInfo[]` |
| `agent:openConfigDir` | `{ agentId }` | `boolean` |
| `agent:settings:get` | `{ agentId }` | `AgentSettingsView` |
| `agent:settings:save` | `{ draft: AgentSettingsDraft }` | `AgentSettingsView` |
| `agent:models:list` | `{ agentId, baseUrl, apiKey, authMode?, customHeaders? }` | `AgentModelOption[]` |
| `agent:upgrade:check` | `{ agentId }` | `AgentUpgradeCheck` |
| `agent:upgrade:run` | `{ agentId }` | `AgentUpgradeResult` |
| `agent:send` | `{ sessionId, prompt, images?, employeeId? }` | `SendAgentResult` |
| `agent:abort` | `{ sessionId }` | `boolean` |
| `agent:permission:respond` | `{ sessionId, requestId, decision }` | `PermissionRespondResult` |
| `agent:permission:list` | — | `PermissionPromptView[]` |

`SendAgentResult`：

```ts
type SendAgentResult =
  | { ok: true; exitCode: number; duration: number }
  | { ok: false; error: string };
```

### 3.2 项目 / 工作区（7）

| 通道 | 参数 | 返回 |
|---|---|---|
| `project:list` | — | `Project[]` |
| `project:create` | `{ name, cwd }` | `Project` |
| `project:delete` | `{ id }` | `boolean` |
| `project:listFiles` | `{ projectId, subPath? }` | `FileEntry[]` |
| `workspace:watch` | `{ projectId, dirs: string[] }` | `void` |
| `project:reveal` | `{ id }` | `boolean` |
| `project:gitStatus` | `{ projectId }` | `GitStatusSummary` |

### 3.2.1 Git（18）

| 通道 | 参数 | 返回 |
|---|---|---|
| `git:statusDetail` | `{ projectId }` | `GitStatusDetail` |
| `git:branches` | `{ projectId }` | `GitBranchInfo[]` |
| `git:log` | `{ projectId, limit? }` | `GitCommitSummary[]` |
| `git:commitFiles` | `{ projectId, hash }` | `GitCommitFile[]` |
| `git:diff` | `{ projectId, relativePath, staged }` | `GitDiffResult` |
| `git:commitFileDiff` | `{ projectId, hash, relativePath, oldPath? }` | `GitDiffResult` |
| `git:stage` | `{ projectId, paths: string[] }` | `GitOperationResult` |
| `git:unstage` | `{ projectId, paths: string[] }` | `GitOperationResult` |
| `git:commit` | `{ projectId, message }` | `GitOperationResult` |
| `git:generateCommitMessage` | `{ projectId }` | `GitCommitMessageResult` |
| `git:checkoutBranch` | `{ projectId, branch }` | `GitOperationResult` |
| `git:createBranch` | `{ projectId, name }` | `GitOperationResult` |
| `git:init` | `{ projectId }` | `GitOperationResult` |
| `git:push` | `{ projectId, branch }` | `GitOperationResult` |
| `git:pull` | `{ projectId }` | `GitOperationResult` |
| `git:discard` | `{ projectId, paths: string[] }` | `GitOperationResult` |
| `git:continueOperation` | `{ projectId }` | `GitOperationResult` |
| `git:abortOperation` | `{ projectId }` | `GitOperationResult` |

### 3.3 文件（3）

| 通道 | 参数 | 返回 |
|---|---|---|
| `file:read` | `{ projectId, relativePath }` | `ReadFileResult` |
| `file:readEmbeddedImage` | `{ projectId, markdownPath, src }` | `ReadEmbeddedImageResult` |
| `file:openExternal` | `{ projectId, relativePath }` | `OpenFileExternalResult` |

### 3.4 终端（4）

| 通道 | 参数 | 返回 |
|---|---|---|
| `terminal:create` | `{ id, cwd?, cols?, rows? }` | `TerminalCreateResult` |
| `terminal:write` | `{ id, data }` | `boolean` |
| `terminal:resize` | `{ id, cols, rows }` | `boolean` |
| `terminal:kill` | `{ id }` | `boolean` |

### 3.5 会话（11）

| 通道 | 参数 | 返回 |
|---|---|---|
| `session:create` | `{ projectId: string \| null, agentId, employeeId?, permissionMode?, model? }` | `Session` |
| `session:list` | — | `Session[]` |
| `session:get` | `{ id, limit?, before?, beforeId? }` | `Session \| null` |
| `session:rename` | `{ id, title }` | `boolean` |
| `session:delete` | `{ id }` | `boolean` |
| `session:setEmployee` | `{ sessionId, employeeId: string \| null }` | `Session \| null` |
| `session:setPermissionMode` | `{ sessionId, permissionMode }` | `Session \| null` |
| `session:setModel` | `{ sessionId, model: string \| null }` | `Session \| null` |
| `session:setPinned` | `{ id, pinned }` | `boolean` |
| `session:setProject` | `{ sessionId, projectId: string \| null }` | `SessionProjectSwitch \| null` |
| `session:defaultCwd` | — | `string` |

`session:get` 传 `limit` 时按页返回最近 N 条并给出 `hasMoreMessages`，更早消息用 `before` / `beforeId` 游标继续取。

### 3.6 对话框 / 设置 / 应用（5）

| 通道 | 参数 | 返回 |
|---|---|---|
| `dialog:pickDirectory` | — | `string \| null` |
| `settings:get` | — | `Partial<AppSettings>` |
| `settings:set` | `Partial<AppSettings>`（单个参数） | `boolean` |
| `window:setAppearance` | `{ appearance: "light" \| "dark" }` | `boolean` |
| `app:info` | — | `AppInfo` |

### 3.7 更新（4）

| 通道 | 参数 | 返回 |
|---|---|---|
| `updater:state` | — | `UpdaterState` |
| `updater:check` | — | `UpdaterState` |
| `updater:download` | — | `boolean` |
| `updater:install` | — | `boolean` |

### 3.8 自动化任务（5）

| 通道 | 参数 | 返回 |
|---|---|---|
| `automation:list` | — | `AutomationTask[]` |
| `automation:create` | `{ prompt, projectId, agentId }` | `AutomationTask` |
| `automation:delete` | `{ id }` | `boolean` |
| `automation:retry` | `{ id }` | `boolean` |
| `automation:stop` | `{ id }` | `boolean` |

### 3.9 数字员工（4）

| 通道 | 参数 | 返回 |
|---|---|---|
| `employees:list` | — | `DigitalEmployee[]` |
| `employees:create` | `{ draft: DigitalEmployeeDraft }` | `DigitalEmployee` |
| `employees:update` | `{ id, draft: DigitalEmployeeDraft }` | `DigitalEmployee \| null` |
| `employees:delete` | `{ id, force? }` | `boolean` |

有会话仍绑定该员工时必须显式 `force`；工作流节点引用不允许强制删除。

### 3.10 MCP（8）

| 通道 | 参数 | 返回 |
|---|---|---|
| `mcp:list` | — | `McpServerAsset[]` |
| `mcp:create` | `{ draft: McpServerDraft }` | `McpWriteResult` |
| `mcp:update` | `{ id, draft: McpServerDraft }` | `McpWriteResult` |
| `mcp:saveDefinition` | `{ id: string \| null, name, definition: string }` | `McpWriteResult` |
| `mcp:delete` | `{ id }` | `boolean` |
| `mcp:import` | `{ json }` | `McpImportResult` |
| `mcp:importFile` | — | `McpImportResult` |
| `mcp:reveal` | `{ id }` | `boolean` |

### 3.11 Skill（7）

| 通道 | 参数 | 返回 |
|---|---|---|
| `skills:list` | — | `SkillAsset[]` |
| `skills:import` | `{ kind: SkillImportKind }` | `SkillImportResult` |
| `skills:delete` | `{ id }` | `boolean` |
| `skills:listFiles` | `{ id }` | `FileEntry[] \| null` |
| `skills:readFile` | `{ id, relativePath }` | `SkillFileDocument \| null` |
| `skills:writeFile` | `{ id, relativePath, content }` | `SkillWriteResult` |
| `skills:reveal` | `{ id }` | `boolean` |

### 3.12 知识库（13）

| 通道 | 参数 | 返回 |
|---|---|---|
| `knowledge:list` | — | `KnowledgeBaseAsset[]` |
| `knowledge:create` | `{ name, description }` | `KnowledgeWriteResult` |
| `knowledge:update` | `{ id, name, description }` | `KnowledgeWriteResult` |
| `knowledge:delete` | `{ id }` | `boolean` |
| `knowledge:listDocuments` | `{ id, subPath? }` | `KnowledgeDocument[]` |
| `knowledge:createFolder` | `{ id, parentPath, name }` | `boolean` |
| `knowledge:upload` | `{ id, parentPath }` | `KnowledgeUploadResult` |
| `knowledge:deleteDocuments` | `{ id, paths: string[] }` | `boolean` |
| `knowledge:search` | `{ query, kbId? }` | `KnowledgeSearchResult` |
| `knowledge:readDocument` | `{ id, relativePath }` | `KnowledgeDocumentContent \| null` |
| `knowledge:writeDocument` | `{ id, relativePath, content }` | `KnowledgeDocumentWriteResult` |
| `knowledge:reveal` | `{ id }` | `boolean` |
| `knowledge:openDocument` | `{ id, relativePath }` | `boolean` |

### 3.13 工作流（5）

| 通道 | 参数 | 返回 |
|---|---|---|
| `workflows:list` | — | `Workflow[]` |
| `workflows:get` | `{ id }` | `Workflow \| null` |
| `workflows:create` | `{ draft: WorkflowDraft }` | `Workflow` |
| `workflows:update` | `{ id, draft: WorkflowDraft }` | `Workflow \| null` |
| `workflows:delete` | `{ id }` | `boolean` |

### 3.14 工作流运行（14）

| 通道 | 参数 | 返回 |
|---|---|---|
| `workflow:run:start` | `{ workflowId }` | `WorkflowRun` |
| `workflow:run:get` | `{ runId }` | `WorkflowRunDetail \| null` |
| `workflow:run:list` | `{ workflowId }` | `WorkflowRun[]` |
| `workflow:run:listByWorkspace` | `{ workspaceId }` | `WorkflowRun[]` |
| `workflow:run:listActive` | — | `WorkflowRun[]` |
| `workflow:run:resume` | `{ runId, nodeRunId? }` | `WorkflowRun` |
| `workflow:run:delete` | `{ runId }` | `boolean` |
| `workflow:run:cancel` | `{ runId }` | `boolean` |
| `workflow:run:approve` | `{ runId, nodeRunId, action: "approve" \| "reject" \| "revise", note? }` | `boolean` |
| `workflow:run:openArtifacts` | `{ runId }` | `boolean` |
| `workflow:run:nodeDetail` | `{ runId, nodeRunId }` | `WorkflowNodeRunDetail \| null` |
| `workflow:run:openNodeArtifacts` | `{ runId, nodeRunId }` | `boolean` |
| `workflow:run:openNodeFile` | `{ runId, nodeRunId, relativePath }` | `boolean` |
| `workflow:run:readNodeFile` | `{ runId, nodeRunId, relativePath }` | `string \| null` |

### 3.15 触发器（7）

| 通道 | 参数 | 返回 |
|---|---|---|
| `triggers:list` | — | `WorkflowTrigger[]` |
| `triggers:create` | `{ draft: WorkflowTriggerDraft }` | `WorkflowTrigger` |
| `triggers:update` | `{ id, draft: WorkflowTriggerDraft }` | `WorkflowTrigger \| null` |
| `triggers:delete` | `{ id }` | `boolean` |
| `triggers:bindings` | — | `WorkflowTriggerBinding[]` |
| `triggers:bindingsForWorkflow` | `{ workflowId }` | `string[]` |
| `triggers:setForWorkflow` | `{ workflowId, triggerIds: string[] }` | `boolean` |

### 3.16 个人待办（7）

| 通道 | 参数 | 返回 |
|---|---|---|
| `todos:list` | — | `TodoItem[]` |
| `todos:create` | `{ draft: TodoDraft }` | `TodoItem` |
| `todos:update` | `{ id, draft: TodoDraft }` | `TodoItem \| null` |
| `todos:toggle` | `{ id, done }` | `TodoItem \| null` |
| `todos:delete` | `{ id }` | `boolean` |
| `todos:clearCompleted` | — | `number` |
| `todos:reorder` | `{ ids: string[] }` | `boolean` |

### 3.17 周报生成（3）

| 通道 | 参数 | 返回 |
|---|---|---|
| `report:generate` | `{ requestId, start, end, options: WeeklyReportOptions }` | `WeeklyReportResult` |
| `report:abort` | `{ requestId }` | `boolean` |
| `report:export` | `{ content, defaultName }` | `string \| null` |

周报走一次性文本生成，不创建会话、不写聊天历史；增量文本经 `report:chunk` 推送。

### 3.18 常用提示词（4）

| 通道 | 参数 | 返回 |
|---|---|---|
| `prompts:list` | — | `PromptItem[]` |
| `prompts:create` | `{ draft: PromptDraft }` | `PromptItem` |
| `prompts:update` | `{ id, draft: PromptDraft }` | `PromptItem \| null` |
| `prompts:delete` | `{ id }` | `boolean` |

---

## 4. 渲染层客户端

`src/renderer/lib/ipc.ts` 把通道收敛为语义化方法：

```ts
export const ipc = {
  detectAgents: () => call("agent:detect"),
  sendAgent: (sessionId, prompt) => call("agent:send", { sessionId, prompt }),
  // ...
  on: {
    agentEvent: (cb) => on("agent:event", cb),
    // ...
  },
};
```

**调用约定**：

- 渲染层只通过 `ipc` 对象调用，不直接 `window.nova.invoke`。
- 订阅通过 `ipc.on.xxx`，返回取消订阅函数；React 在 `useEffect` 清理。
- 类型全部由 `IpcInvokeMap` / `IpcPushMap` 推导，方法签名不重复写。

---

## 5. 错误与业务失败约定

### 5.1 抛错（invoke reject）

适用于“参数非法 / 资源不存在 / 权限问题”等无法继续的情况：

```ts
handle("session:rename", ({ id, title }) => {
  if (!title.trim()) throw new Error("会话标题不能为空");
  // ...
});
```

渲染层：

```ts
try {
  await ipc.renameSession(id, title);
} catch (err) {
  toast.error(String(err));
}
```

### 5.2 返回联合类型

适用于“业务失败是正常分支”的情况，例如 `agent:send`、MCP/Skill/知识库写入：

```ts
type McpWriteResult =
  | { ok: true; asset: McpServerAsset }
  | { ok: false; error: string };
```

**不要混用**：同一个通道只用一种失败表达方式。

### 5.3 静默降级

少数场景失败不抛错，返回空值或 `false`：

- `agent:abort`：没有运行中的会话返回 `false`；
- `skills:listFiles`：技能目录不存在返回 `null`；
- `project:reveal`：路径不存在返回 `false`。

---

## 6. 新增一个 IPC 通道的步骤

1. 在 `src/shared/contracts/ipc.ts` 的 `IpcInvokeMap` 加一条：

```ts
"demo:ping": { args: [{ text: string }]; result: string };
```

2. 在对应 handler 注册：

```ts
handle("demo:ping", ({ text }) => `pong:${text}`);
```

3. 在 `src/renderer/lib/ipc.ts` 加语义化方法：

```ts
ping: (text: string) => call("demo:ping", { text }),
```

4. 类型检查通过后，三处自动对齐。

**新增 push 通道**：

1. 在 `IpcPushMap` 加一条；
2. 需要聚合就在 `push.ts` 的 `BATCH_WINDOWS` 加窗口；
3. 渲染层 `ipc.on` 加订阅；
4. 主进程用 `push(channel, payload)`。

---

## 7. 通道与 handler 对照

| 域 | handler 文件 |
|---|---|
| agent | `src/main/ipc/handlers/agent.ts` |
| session | `src/main/ipc/handlers/session.ts` |
| project / workspace:watch | `src/main/ipc/handlers/project.ts` |
| git | `src/main/ipc/handlers/git.ts` |
| file | `src/main/ipc/handlers/file.ts` |
| terminal | `src/main/ipc/handlers/terminal.ts` |
| settings | `src/main/ipc/handlers/settings.ts` |
| dialog | `src/main/ipc/handlers/dialog.ts` |
| app | `src/main/ipc/handlers/app.ts` |
| updater | `src/main/ipc/handlers/updater.ts` |
| automation | `src/main/ipc/handlers/automation.ts` |
| employee | `src/main/ipc/handlers/employee.ts` |
| mcp | `src/main/ipc/handlers/mcp.ts` |
| skill | `src/main/ipc/handlers/skill.ts` |
| knowledge | `src/main/ipc/handlers/knowledge.ts` |
| workflow | `src/main/ipc/handlers/workflow.ts` |
| workflow-run | `src/main/ipc/handlers/workflow-run.ts` |
| trigger | `src/main/ipc/handlers/trigger.ts` |
| todo | `src/main/ipc/handlers/todo.ts` |
| report | `src/main/ipc/handlers/report.ts` |
| prompt | `src/main/ipc/handlers/prompt.ts` |

---

## 8. 复刻验收清单

- [ ] `IpcInvokeMap` / `IpcPushMap` 是唯一通道定义，三处消费。
- [ ] preload 只暴露 `invoke` / `subscribe`。
- [ ] 139 个 invoke 通道全部注册，无遗漏、无重复。
- [ ] 17 个 push 通道全部可订阅、可取消。
- [ ] `agent:event` 与 `workflow:run:agentEvent` 走 16ms 聚合。
- [ ] 状态事件前调用 `flushEvents()`。
- [ ] handler 抛错能被渲染层捕获并提示。
- [ ] 业务失败统一用联合类型，不混用抛错。
- [ ] 新增通道只需改契约、handler、客户端三处。
