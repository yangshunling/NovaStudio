# 05 Agent 运行时抽象

## 1. 目的与边界

本层回答一个问题：

> 宿主如何以统一的方式驱动任意一个「命令行 AI Agent」，而不把某家 CLI 的协议知识泄漏到会话、工作流、IPC 与 UI。

包含：

- `AgentProvider` 契约；
- provider 注册表；
- 子进程传输层（spawn / stdin / 环境 / 终止）；
- 行分隔协议运行器；
- 事件模型与合并规则；
- `AgentService` 的会话运行编排、历史缓存、清理。

不包含：

- 具体 CLI 的 JSON 解析（在 provider 内，见 `06-Claude-Code适配层`）；
- 会话列表 / UI；
- 工作流调度（见 08-10）。

**核心原则**：provider 拥有自己的传输方式、行切分、事件解码、会话存储；宿主只消费归一化后的 `AgentEvent` 与 `RunResult`。

---

## 2. Provider 契约

文件：`src/main/agents/types.ts`

### 2.1 `AgentProvider`

```ts
export interface AgentProvider {
  readonly manifest: AgentManifest;

  detect(): Promise<AgentStatus>;

  configInfo?(): AgentConfigLocation;

  describeRuntimeConfig?(): Record<string, string>;

  prepareRun?(input: AgentRunInput): PreparedAgentRun | Promise<PreparedAgentRun>;

  start(opts: RunOptions): RunSession;

  normalizeSessionRef(rawId: string, ctx: SessionContext): string;

  historyVersion(ref: string, ctx: SessionContext): string | null;

  readHistory(ref: string, ctx: SessionContext): Message[];

  deleteSession(ref: string, ctx: SessionContext): void;
}
```

### 2.2 `AgentManifest` / 能力声明

来自 `shared/contracts/agent.ts`：

```ts
export interface AgentCapabilities {
  /** 是否支持 --resume 多轮 */
  resume: boolean;
  /** 会话数据是否在 CLI 侧，删除时要同步清理 */
  sessionCleanup: boolean;
  /** 是否支持按员工加载 Skill */
  skills: boolean;
  /** 是否支持按员工加载 MCP */
  mcp: boolean;
}

export interface AgentManifest {
  id: string;
  displayName: string;
  order: number;
  tone?: AgentTone;
  capabilities: AgentCapabilities;
  installCommand?: string;
}
```

**能力驱动的行为**：

- `resume=false`：`AgentService` 不保存 `agentSessionId`，每次都是新会话。
- `sessionCleanup=false`：删除会话时不调用 `deleteSession`。
- `skills=false` / `mcp=false`：员工侧不显示对应页签，运行时忽略绑定。

Claude 的 manifest：

```ts
{
  id: "claude",
  displayName: "Claude Code",
  order: 30,
  tone: "sky",
  capabilities: { resume: true, sessionCleanup: true, skills: true, mcp: true },
  installCommand: "npm install -g @anthropic-ai/claude-code",
}
```

### 2.3 `RunOptions` — 一次调用的输入

```ts
export interface RunOptions {
  prompt: string;
  cwd: string;
  mode?: "chat" | "workflow";
  sessionRef: string | null;
  opts?: SessionOptions;             // 宿主内部注入，如 { systemPrompt }
  timeoutMs?: number;
  env?: Record<string, string>;      // 追加环境变量
  envRemove?: string[];              // 剔除环境变量
  extraArgs?: string[];              // provider 额外参数
  configDir?: string | null;         // CLI 配置目录（历史定位用）
  onEvent: (event: AgentEvent) => void;
  onSessionId: (rawId: string) => void;
  onInvocation?: (info: AgentInvocationInfo) => void;
}
```

### 2.4 `RunSession` — 运行句柄

```ts
export interface RunSession {
  readonly done: Promise<RunResult>;
  readonly aborted: boolean;
  abort(): void;
}
```

### 2.5 `PreparedAgentRun` — provider 准备的环境

```ts
export interface PreparedAgentRun {
  configDir?: string | null;
  env?: Record<string, string>;
  envRemove?: string[];
  extraArgs?: string[];
  warnings?: string[];
  injected?: {
    mcpServers: string[];
    skills: string[];
  };
}
```

宿主只负责应用这些返回值，不感知它们如何生成。

### 2.6 `AgentInvocationInfo` — 审计信息

```ts
export interface AgentInvocationInfo {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: Record<string, string>;
  envRemove?: string[];
  notes?: string[];
}
```

用于写 `execution.md`，排查“到底哪个参数不对”。

---

## 3. Provider 注册表

文件：`src/main/agents/registry.ts`

```ts
const modules = import.meta.glob<{ provider: AgentProvider }>("./*/index.ts", {
  eager: true,
});
const PROVIDERS = Object.values(modules).map((m) => m.provider);

export function listProviders(): AgentProvider[] {
  return [...PROVIDERS].sort((a, b) => a.manifest.order - b.manifest.order);
}

export function getProvider(id: string): AgentProvider | undefined {
  return PROVIDERS.find((p) => p.manifest.id === id);
}
```

**约定**：

- 每个 provider 是一个目录：`src/main/agents/<id>/index.ts` 必须导出 `provider`；
- 可选 `manifest.ts` / `parse.ts` / `sessions.ts` / `prepare.ts`；
- 展示顺序由 `manifest.order` 决定，与目录名无关；
- 至少一个 provider，否则启动抛错。

**新增 Agent 的步骤**：

1. 新建 `src/main/agents/<id>/index.ts`，导出 `provider`；
2. 在 `manifest.ts` 声明 id / 能力 / 安装命令；
3. 实现 `start`（可复用 `startLineRun`）；
4. 实现历史相关方法；
5. 不需要改 registry、engine、IPC、UI。

---

## 4. 传输层

文件：`src/main/agents/transport.ts`

职责：把命令跑起来，把 stdout / stderr 原样吐出来。**不切行、不解析 JSON、不知道 Agent 存在。**

### 4.1 `spawnChild`

```ts
export function spawnChild(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> | undefined,
  envRemove: string[] | undefined,
  handlers: TransportHandlers,
): Transport;
```

`TransportHandlers`：

```ts
interface TransportHandlers {
  onData: (chunk: string) => void;     // stdout：协议数据
  onStderr?: (chunk: string) => void;  // stderr：诊断，单独通道
  onExit: (exitCode: number) => void;
}
```

### 4.2 Windows 特殊处理

Windows 下：

```ts
const file = "cmd.exe";
const argv = ["/d", "/s", "/c", `"${args.map(quoteForCmd).join(" ")}"`];

spawn(file, argv, {
  cwd,
  windowsHide: true,
  env: buildEnv(envOverrides, envRemove),
  windowsVerbatimArguments: true,
});
```

**为什么**：

- `claude` 通常是 npm 全局安装的 `.cmd`，必须经 `cmd.exe` 解析；
- Node 默认的逐参数引号只处理空白 / 双引号，不处理 cmd 的 `& | < > ^ ( ) % !`；
- `windowsVerbatimArguments` + 自己拼串 + 外层引号，配合 `/s` 由 cmd 去掉外层、保留参数自己的引号。

**引号规则**：

```ts
const NEEDS_QUOTE = /[\s"&|<>^()]/;
function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  return NEEDS_QUOTE.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
```

> `%VAR%` 展开是 cmd 自身语义，加引号也无法阻止；正常路径 / ID / 配置路径不会包含它。

### 4.3 环境变量

```ts
function buildEnv(overrides, remove) {
  const env = { ...process.env, ...overrides };
  for (const key of remove ?? []) delete env[key];
  return env;
}
```

**`envRemove` 必须最后生效**：否则 `process.env` 里的同名变量会在展开时重新出现，覆盖节点自己的隔离配置。

### 4.4 进程退出

- `close` 优先：保留尾部输出；
- `exit` 后留 500ms 宽限：如果 `close` 不来（MCP / hook 等孙进程持有 stdio），主动收尾；
- `reportExit` 保证只回调一次。

### 4.5 终止

```ts
kill() {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  child.kill();
}
```

**为什么 Windows 用 taskkill**：子进程是 `cmd.exe`，只 kill 它不会带走 `claude`；`/T` 终止整棵进程树，避免取消后仍在后台跑。

### 4.6 写入 stdin

```ts
writeInput(data) {
  child.stdin?.end(data);
}
```

prompt 必须走 stdin：Windows 下命令行参数中的换行会被 cmd 截断，后半段参数全部丢失。

### 4.7 `stripAnsi`

过滤：

- CSI：颜色 / 光标 / 清屏 `\x1b[...X`
- OSC：窗口标题 `\x1b]...`
- 字符集选择 `\x1b(B` 等
- 单字符 ESC 序列
- 控制字符、`\r`

**为什么**：PTY / 子进程可能输出控制序列，会破坏 JSON 行解析。

### 4.8 `createLineBuffer`

```ts
push(chunk): string[]  // 返回本次凑齐的完整行，尾部残片留到下次
take(): string         // 进程退出时取走残片
```

### 4.9 `execCli`

用于安装探测等一次性调用：

- Windows：`cmd.exe /d /s /c <commandLine>`
- 其他：直接 `execFile(args[0], args.slice(1))`
- `windowsHide: true`
- 带超时

---

## 5. 行分隔运行器

文件：`src/main/agents/line-run.ts`

适用：stdout 按行输出、每行可独立解码的 CLI（Claude Code）。

### 5.1 输入

```ts
export interface LineRunConfig {
  args: string[];
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  envRemove?: string[];
  stdin?: string;
  extractSessionId(line: string): string | null;
  decode(line: string): AgentEvent | AgentEvent[] | null;
}
```

### 5.2 生命周期

```mermaid
stateDiagram-v2
  [*] --> Running
  Running --> Running: stdout 行 → decode → onEvent
  Running --> Settled: 进程退出
  Running --> Aborted: 用户 abort()
  Running --> TimedOut: 超时
  Running --> StartFailed: spawn 抛错
  Settled --> [*]
  Aborted --> [*]
  TimedOut --> [*]
  StartFailed --> [*]
```

### 5.3 两个关键标志

| 标志 | 语义 | 影响 |
|---|---|---|
| `aborted` | 用户主动中断 | 不记为失败，不带错误信息 |
| `muted` | 已中断 / 已超时 / 启动失败 | 抑制后续输出与重复事件 |

**不能混用**：如果把超时、启动失败也当成 `aborted`，调用方会把失败误判为用户中断。

### 5.4 超时

```ts
timer = setTimeout(() => {
  const message = `Agent timed out after ${Math.round(timeoutMs / 60000)} min`;
  emit({ type: "error", message });   // 必须在 muted 之前发
  muted = true;
  transport?.kill();
  finish(-1, message);
}, timeoutMs);
```

默认 30 分钟，可由设置 `agentTimeoutMinutes` 覆盖。

### 5.5 中断

```ts
abort() {
  if (settled) return;
  aborted = true;
  muted = true;
  transport?.kill();
  setTimeout(() => finish(-1), 1500); // kill 可能不触发 exit
}
```

### 5.6 stderr

只保留尾部 4000 字符，用于非零退出的诊断；不进入协议解析。

### 5.7 退出收尾

- 先处理行缓冲残片（最后一行可能没有换行）；
- 非零退出且没有 error 事件时，补一条 `error`；
- `RunResult.error` 同时携带诊断，供宿主恢复策略使用。

### 5.8 行处理

```ts
const handleLine = (raw) => {
  const line = raw.trim();
  if (!line) return;
  const sid = config.extractSessionId(line);
  if (sid) handlers.onSessionId(sid);
  const decoded = config.decode(line);
  for (const event of toArray(decoded)) emit(event);
};
```

**每次运行新建解码器**：它需要记住本次运行内的工具调用 id → 工具名映射。

---

## 6. 事件模型

类型见 `src/shared/types.ts`：

```ts
export type AgentEvent =
  | { type: "thinking"; content: string }
  | { type: "text"; content: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; callId?: string; name: string; input: unknown; kind: ToolKind; target: string }
  | { type: "tool_result"; callId?: string; name: string; output: string; isError?: boolean }
  | { type: "error"; message: string }
  | { type: "warning"; message: string }
  | { type: "done" }
  | { type: "message_end"; blocks: AgentEvent[] };
```

合并规则见 `shared/agent-events.ts`，详细语义见 [附录 A](附录/A-AgentEvent事件模型.md)。

**宿主只依赖这些语义，不出现具体工具名。**

### 6.1 工具展示归一化

文件：`src/main/agents/tool-display.ts`

```ts
export interface ToolDisplay {
  kind: "read" | "write" | "exec" | "search" | "other";
  target: string;
}

export function describeTool(name: string, input: unknown): ToolDisplay;
```

- 工具名 → 分类的映射在 provider 侧（因为只有 provider 知道工具叫什么）；
- 操作对象从 `path` / `file` / `filePath` / `file_path` / `command` / `pattern` / `query` 中取；
- 所有工具都进入消息流，包括 Bash；是否折叠由展示层决定。

---

## 7. AgentService

文件：`src/main/agents/agent-service.ts`

`AgentService` 是会话与运行的唯一编排入口，不感知 Electron 与 IPC。

### 7.1 接口

```ts
export interface AgentService {
  listAgentInfos(): Promise<AgentInfo[]>;
  resolveCwd(...candidates: (string | undefined | null)[]): string;
  run(params: RunParams): Promise<RunOutcome>;
  abort(sessionId: string): boolean;
  getSessionWithHistory(sessionId: string): Session | null;
  releaseSession(sessionId: string): Promise<void>;
  releaseProject(projectId: string): Promise<void>;
  shutdown(): void;
}
```

### 7.2 内部状态

```ts
const running = new Map<string, RunSession>();
const historyCache = new Map<string, { version: string; messages: Message[] }>();
```

- `running`：同一会话只允许一个运行；
- `historyCache`：LRU，上限 32；缓存键是 `agentId + configDir + agentSessionId`。

### 7.3 `run()` 流程

```mermaid
sequenceDiagram
  participant Svc as AgentService
  participant DB as SQLite
  participant P as Provider
  participant CLI as 子进程

  Svc->>DB: getSession(sessionId)
  alt 不存在 / 已在运行
    Svc-->>调用方: failed
  end
  Svc->>P: getProvider(agentId)
  Svc->>Svc: canResume = capabilities.resume && agentSessionId
  alt 本地无消息且已有 agentSessionId
    Svc->>P: readHistoryCached
    Svc->>DB: importSessionMessages
  end
  Svc->>DB: saveSessionMessage(user)
  Svc->>P: start({ prompt, cwd, sessionRef, ... })
  P->>CLI: spawn
  loop 事件
    CLI-->>P: 行
    P-->>Svc: onEvent
    Svc->>Svc: appendEvent 累积 assistantContent
    Svc->>调用方: emit('agent:event')（非 workflow 会话）
  end
  CLI-->>P: 退出
  Svc->>Svc: 判断 resumeFailed
  Svc->>DB: saveSessionMessage(assistant)
  Svc->>DB: updateAgentSessionId / clearAgentSessionId
  Svc->>Svc: running.delete
  Svc-->>调用方: RunOutcome
```

### 7.4 用户消息先落库

```ts
db.saveSessionMessage(sessionId, userMsg);
params.onUserMessage?.(userMsg.id);
```

即使运行失败，用户也能看到原始指令。工作流用 `onUserMessage` 立即记录本轮起点。

### 7.5 assistant 消息落库

- 只累积非 `done` 事件；
- 无论成功 / 失败 / 中断，只要 `assistantContent.length > 0` 就落库；
- 落库内容与渲染层使用同一套 `appendEvent`，保证内存与 DB 一致。

### 7.6 resume 失效自愈

```ts
const failureText = [result.error, ...errorMessages].filter(Boolean).join("\n");
const resumeFailed =
  Boolean(sessionRef) && !runSession.aborted && isResumeFailure(failureText);
if (resumeFailed) {
  historyCache.delete(previousKey);
  db.clearAgentSessionId(sessionId);
  // 推送 warning
}
```

`isResumeFailure` 覆盖文案：

```
No conversation found with session ID
could not find conversation
session ... not found
unable to resume
```

**为什么必须自愈**：否则后续每次发送都会继续 `--resume` 同一个不存在的会话，永久失败。

### 7.7 会话引用落库

```ts
if (!resumeFailed && captured.rawId) {
  const ref = provider.normalizeSessionRef(captured.rawId, { cwd });
  if (ref !== session.agentSessionId) db.updateAgentSessionId(sessionId, ref);
}
```

即使本轮被中断 / 超时，只要拿到了 CLI 会话 id 也要落库，因为 CLI 侧会话仍然存在且可恢复。否则用户追问时会“失忆”。

### 7.8 历史回放

```ts
getSessionWithHistory(sessionId) {
  const persisted = db.readSessionMessages(sessionId);
  if (persisted) return { ...session, messages: persisted };
  return { ...session, messages: readHistoryCached(session) };
}
```

- 优先 DB（含工具调用细节）；
- DB 无数据时回退 provider 从 CLI 侧回放（仅文本）。

### 7.9 历史缓存

```ts
function readHistoryCached(session) {
  const version = provider.historyVersion(ref, ctx);
  if (version !== null) {
    const cached = historyCache.get(key);
    if (cached && cached.version === version) return cached.messages; // LRU touch
  }
  const messages = provider.readHistory(ref, ctx);
  if (version !== null) historyCache.set(key, { version, messages });
  return messages;
}
```

**缓存键必须包含 `configDir`**：同一会话引用在隔离配置目录下指向不同文件。

**版本号契约**：版本号不变 ⟺ `readHistory` 结果不变。Claude 用文件 mtime。

### 7.10 清理

```ts
releaseSession(sessionId) {
  running.get(sessionId)?.abort();
  await waitForIdle(sessionId);   // 最多 5s
  dropSessionArtifacts(sessionId);
}
```

- 先中断并等待收尾，再删 CLI 侧数据与缓存；
- 顺序不能反：运行收尾还会写 messages，提前删会话会触发外键错误。
- `releaseProject` 对项目下所有会话执行同样流程。

### 7.11 超时

```ts
function resolveTimeoutMs(): number {
  const raw = db.getSetting("agentTimeoutMinutes");
  const minutes = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return DEFAULT_SETTINGS.agentTimeoutMinutes * 60_000;
  }
  return Math.max(1, Math.round(minutes)) * 60_000;
}
```

至少 1 分钟，避免 0.5 分钟被向下取整成 0ms 立即超时。

### 7.12 `shutdown()`

中断所有运行中的会话；不等待，进程即将退出。

---

## 8. 版本探测

文件：`src/main/agents/probe.ts`

```ts
export async function probeVersion(bin, args = ["--version"]): Promise<AgentStatus>;
```

- 执行 `<bin> --version`；
- 失败即视为未安装；
- 从输出提取 `\d+\.\d+\.\d+`；
- 10 秒超时；
- 异步执行，避免阻塞主进程启动。

---

## 9. 新增 provider 的最小清单

- [ ] `src/main/agents/<id>/index.ts` 导出 `provider`；
- [ ] `manifest.ts` 声明 id / displayName / order / capabilities / installCommand；
- [ ] 实现 `detect`（可复用 `probeVersion`）；
- [ ] 实现 `start`（行协议可复用 `startLineRun`，否则自己实现）；
- [ ] 实现 `normalizeSessionRef` / `historyVersion` / `readHistory` / `deleteSession`；
- [ ] 如需按员工注入 MCP/Skill，实现 `prepareRun`；
- [ ] 如需运行产物配置快照，实现 `describeRuntimeConfig`；
- [ ] 不需要改 registry / engine / IPC / UI。

---

## 10. 复刻验收清单

- [ ] `AgentProvider` 契约完整，宿主不出现具体 CLI 工具名。
- [ ] registry 用 `import.meta.glob` 自动收集，按 order 排序。
- [ ] Windows 下 `.cmd` 经 `cmd.exe` 启动，特殊字符不被拆分。
- [ ] prompt 走 stdin，多行不被截断。
- [ ] 终止在 Windows 下杀整棵进程树。
- [ ] `aborted` 与 `muted` 语义分离。
- [ ] 超时 / 启动失败不会被误判为用户中断。
- [ ] `agent:event` 事件经过 `appendEvent`，内存与 DB 一致。
- [ ] 同一会话并发发送被拒绝。
- [ ] resume 失效会自动清除引用并提示。
- [ ] 历史缓存键包含 configDir，LRU 上限 32。
- [ ] 删除会话先中断等待，再删 CLI 数据与 DB 行。
