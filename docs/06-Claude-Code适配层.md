# 06 Claude Code 适配层

## 1. 目的与边界

本层是 `AgentProvider` 的第一个、也是当前唯一实现。它把 Claude Code CLI 的协议细节全部封装在 `src/main/agents/claude/`，宿主不感知。

包含：

- CLI 可执行文件探测与版本升级；
- 命令行参数拼装（权限模式、工具授权、图片输入）；
- stream-json 协议解析（含 `can_use_tool` 控制帧与用量）；
- 会话 JSONL 定位、回放、删除与迁移；
- `~/.claude/settings.json` 读写；
- 模型列表拉取；
- 聊天 / 工作流共用的员工运行时投影；
- 运行现场配置摘要。

不包含：

- 会话 / 运行编排（在 `AgentService`，见 05）；
- UI（在 07 / 17）。

---

## 2. CLI 调用约定

文件：`src/main/agents/claude/index.ts`

### 2.1 首次调用

```bash
claude -p \
  --output-format stream-json \
  --verbose \
  --include-partial-messages
```

### 2.2 恢复会话

```bash
claude -p --resume <session_id> \
  --output-format stream-json \
  --verbose \
  --include-partial-messages
```

### 2.3 关键开关

| 开关 | 作用 | 为什么必须 |
|---|---|---|
| `-p` | print 模式（非交互） | 一次性执行 |
| `--output-format stream-json` | 每行一个 JSON 事件 | 流式解析的基础 |
| `--verbose` | `-p` 模式下输出 stream-json 需要它 | 不加会被 CLI 拒绝 |
| `--include-partial-messages` | 提供 `content_block_delta` | 打字机效果 |
| `--resume <id>` | 恢复会话 | 多轮上下文 |
| `--permission-mode <mode>` | 会话级权限快照 | `default` → `manual`；未知值不传 |
| `--permission-prompt-tool stdio` | 交互式工具授权 | CLI 用 `can_use_tool` 询问，应答写回 stdin |
| `--input-format stream-json` | 用户消息按 content block 传入 | 图片输入 / 控制应答必需 |
| `--append-system-prompt-file <path>` | 追加系统提示词 | 多行文本不能走命令行 |
| `--mcp-config` / `--strict-mcp-config` | 员工 MCP 投影 | 隔离全局 MCP |
| `--system-prompt-snapshot off` | 每轮重新渲染系统提示词 | 切换员工时提示词必须跟着变 |

### 2.4 不传的参数

- **`--model` 仅在会话显式选择模型时传**：未选择时不传，模型由 `~/.claude/settings.json` 的 `ANTHROPIC_MODEL` / 别名决定。
- **不传 `--permission-mode`**：权限由 `permissions.defaultMode` 决定，终端 claude、Nova 会话、工作流节点共用同一份配置。
- **不传 `--no-session-persistence`**：人工审核「要求修改」需要在同一 CLI 会话里续聊。

### 2.5 prompt 走 stdin

```ts
stdin: opts.prompt
```

**为什么**：Windows 下经 `cmd.exe` 启动时，命令行参数中的换行会把整条命令截断，`--output-format` / `--mcp-config` 等后半段开关会整个丢失。工作流 prompt 与系统提示词几乎必然包含换行。

### 2.6 系统提示词走临时文件

```ts
const systemPromptFile = writeSystemPromptFile(prompt);
args.push("--append-system-prompt-file", systemPromptFile.path);
```

临时目录：`os.tmpdir()/novastudio-system-<random>/system.md`，运行结束 `finally` 清理。

**为什么**：系统提示词同样是多行文本，不能作为命令行参数。

### 2.7 运行命令行的最终形态

```ts
[
  "claude",
  "-p",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  ...(sessionRef ? ["--resume", sessionRef] : []),
  ...(model ? ["--model", model] : []),
  ...(systemPromptFile ? ["--append-system-prompt-file", path] : []),
  ...extraArgs,   // 工作流的 --mcp-config / --strict-mcp-config
]
```

prompt 通过 stdin 传入，不在参数里。

### 2.8 `onInvocation`

启动前把精确调用信息交给宿主：

```ts
{
  command: "claude",
  args: [...],
  cwd,
  stdin: "任务输入（prompt 通过 stdin 传入，内容见「任务输入」章节）",
  env,
  envRemove,
  notes: [
    "prompt 通过 stdin 传入，不在命令行参数中（避免 Windows cmd.exe 截断换行）",
    "系统提示词写入临时文件后通过 --append-system-prompt-file 传入",
    "未显式选择模型时未传 --model：模型由本机 Claude settings.json 决定",
    "未传 --permission-mode：权限由本机 Claude settings.json 决定",
  ],
}
```

---

## 3. stream-json 协议

### 3.1 每行一个 JSON 对象

```jsonc
// 初始化
{"type":"system","subtype":"init","session_id":"...","tools":[...]}

// 增量
{"type":"stream_event","event":{"type":"message_start",...},"session_id":"..."}
{"type":"stream_event","event":{"type":"content_block_delta",
  "delta":{"type":"text_delta","text":"..."}},"session_id":"..."}
{"type":"stream_event","event":{"type":"content_block_delta",
  "delta":{"type":"thinking_delta","thinking":"..."}},"session_id":"..."}

// 完整 assistant 消息（按 content block 逐条发，每条只带一个块）
{"type":"assistant","message":{"id":"msg_...","role":"assistant","content":[
  {"type":"text","text":"..."} |
  {"type":"thinking","thinking":"..."} |
  {"type":"tool_use","id":"toolu_...","name":"Read","input":{...}}
]},"session_id":"...","parent_tool_use_id":null}

// 工具回执
{"type":"user","message":{"role":"user","content":[
  {"type":"tool_result","tool_use_id":"toolu_...","content":"...","is_error":false}
]},"session_id":"..."}

// 最终结果
{"type":"result","subtype":"success","session_id":"...","result":"..."}
{"type":"result","subtype":"error_during_execution","is_error":true,
 "errors":["No conversation found with session ID: ..."]}
```

### 3.2 会话 id

每一行都带 `session_id`。`extractSessionId` 直接 JSON.parse 后取它：

```ts
export function extractSessionId(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    return typeof obj.session_id === "string" ? obj.session_id : null;
  } catch {
    return null;
  }
}
```

### 3.3 子代理对话

`parent_tool_use_id` 非空且非空串 → 忽略。子代理（Task 工具）的对话不进入主对话视图。

---

## 4. 解码策略

文件：`src/main/agents/claude/parse.ts`

### 4.1 核心难点：assistant 是逐块发送的

Claude 的 `assistant` 事件**按 content block 逐条发**：一个 text 块、一个 tool_use 块就是两条 `assistant`，每条只带自己那一个块。

如果直接把单块当“本轮权威块”发出去，`appendEvent` 的 `message_end` 收敛规则会连同同一条消息里前面已经完成的块一起删掉——思考与正文会被随后的块吃掉。

### 4.2 解决方案：按消息归组

```ts
interface MessageBuffer {
  id: string | null;        // 当前 assistant 消息的 message.id
  blocks: AgentEvent[];     // 该消息已收到的全部可展示块
}
```

- `stream_event.message_start` → 清空 buffer；
- `assistant` → 把本次块并入 buffer，然后发 `{ type: "message_end", blocks: [...buffer.blocks] }`；
- `appendEvent` 会把末尾累积块整段替换成这份全集，于是 delta 与完整块不重复，同一条消息里先到的块也不会被后到的块删掉。

### 4.3 工具回执是执行边界

并行工具调用时，`tool_result` 可能夹在同一条 assistant 消息的后续块之前到达。

```ts
if (type === "user") {
  const events = mapToolResultBlocks(content, names);
  if (events.length > 0) {
    buffer.blocks = [];
    buffer.id = null;
  }
  return events.length > 0 ? events : null;
}
```

**为什么必须清空**：`appendEvent` 的收敛遇到中间夹着的 `tool_result` 就停住，只能整段追加；如果继续累积，回执之前的正文与 tool_call 会被重复一遍。重复的 tool_call 只有一份 result，界面上会永久停在“进行中”。

### 4.4 tool_use / tool_result 配对

协议里 `tool_result` 只有 `tool_use_id`，没有工具名。解码器在本次运行内维护：

```ts
type CallNames = Map<string, string>; // tool_use id → name
```

- `mapAssistantBlocks` 遇到 `tool_use` 时记录 `names.set(block.id, block.name)`；
- `mapToolResultBlocks` 用 `names.get(block.tool_use_id)` 补上 name，取不到回退 `"tool"`。

### 4.5 内容块映射

```ts
function mapAssistantBlocks(content, names): AgentEvent[] {
  for (const block of content) {
    if (block.type === "thinking") push thinking;
    if (block.type === "text") push text;
    if (block.type === "tool_use") {
      names.set(id, name);
      const display = describeTool(name, input);
      push { type: "tool_call", callId, name, input, kind, target };
    }
    // redacted_thinking / image 等忽略
  }
}
```

### 4.6 result 错误子类型

```ts
if (type === "result") {
  const isError = obj.is_error === true || subtype.startsWith("error");
  if (!isError) return null;
  const message = errors.join("\n").trim() || result.trim() || `Agent 执行失败（${subtype}）`;
  return { type: "error", message };
}
```

**为什么**：CLI 某些错误以 0 退出，如果只看退出码会误判为成功。典型是 `--resume` 失效：

```json
{"type":"result","subtype":"error_during_execution","is_error":true,
 "errors":["No conversation found with session ID: ..."]}
```

### 4.7 解码器生命周期

```ts
export function createDecoder() {
  const names = new Map();
  const buffer = { id: null, blocks: [] };
  return (line) => decode(line, names, buffer);
}
```

**每次运行新建解码器**：工具 id → 名称的映射只在本次运行内有效。

### 4.8 非 JSON 行

直接忽略（Claude 自己打印的告警等）。

---

## 5. 会话存储

文件：`src/main/agents/claude/sessions.ts`

### 5.1 存储位置

```
<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects/<cwd 转义名>/<session-uuid>.jsonl
```

> 宿主进程设置了 `CLAUDE_CONFIG_DIR` 时，CLI 与历史回放 / 删除必须使用
> 同一个根目录；`sessions.ts` 通过 `claudeConfigDir()` 解析，不能硬编码
> `~/.claude`。

工作流节点使用独立配置目录时：

```
<configDir>/projects/<cwd 转义名>/<session-uuid>.jsonl
```

### 5.2 cwd 转义

```ts
function encodeCwd(cwd: string): string {
  return cwd.split(/[\\/:]/).join("-");
}
```

例：`C:\Users\a` → `C--Users-a`。

### 5.3 定位文件

```ts
function locateSessionFile(cwd, sessionId, configDir): string | null {
  // 快路径：由 cwd 推目录名直接命中
  const fast = join(root, encodeCwd(cwd), `${sessionId}.jsonl`);
  if (existsSync(fast)) return fast;

  // 兜底：全量扫描
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
```

**为什么需要兜底**：Windows 上 claude 生成的目录名大小写不稳定（`C--` vs `c--`），不能只靠字符串相等；会话 uuid 全局唯一，按文件名扫描不会误命中。

### 5.4 路径安全

```ts
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
```

会话 id 会直接拼进文件路径，必须挡住 `/`、`\`、`.` 等分隔符，否则 `"../../x"` 这类 id 能让读取 / 删除跑到会话目录之外。

### 5.5 JSONL 记录

```jsonc
{"type":"user"|"assistant","message":{"role":...,"content":...},
 "uuid":"...","timestamp":"...","isSidechain":false}
{"type":"attachment"|"queue-operation"|"atis-latch"|...}
```

- 只渲染 `user` / `assistant`；
- `isSidechain: true` 的子代理对话跳过；
- `user.content` 为字符串 → 用户输入；
- `user.content` 为数组 → 工具回执，追加到上一条 assistant 消息；
- `assistant.content` 经 `mapAssistantBlocks` 转事件；块为空（只剩不展示的工具）时不进消息流，避免空气泡；
- 其他系统记录跳过。

### 5.6 版本号

```ts
export function fileVersion(ref, cwd, configDir): string | null {
  const file = locateSessionFile(cwd, ref, configDir);
  if (!file) return null;
  return String(statSync(file).mtimeMs);
}
```

历史缓存用 mtime 判断是否失效。

### 5.7 删除

```ts
rmSync(file, { force: true });
rmdirSync(dirname(file)); // 仅空目录成功，非空抛错被忽略
```

**绝不做递归删除**：同一目录下可能存在其他会话文件。

---

## 6. 本机配置

文件：`src/main/agents/claude/config.ts`

### 6.1 路径

| 用途 | 路径 | 函数 |
|---|---|---|
| 配置根目录 | `$CLAUDE_CONFIG_DIR` 或 `~/.claude` | `claudeConfigDir()` |
| 全局技能 | `<configDir>/skills` | `claudeSkillsDir()` |
| settings | `<configDir>/settings.json` | `claudeSettingsPath()` |
| OAuth 凭证 | `<configDir>/.credentials.json` | `claudeCredentialsPath()` |
| 用户配置 / MCP | `$CLAUDE_CONFIG_DIR/.claude.json` 或 `~/.claude.json` | `claudeUserConfigPath()` |

> Claude 在设置 `CLAUDE_CONFIG_DIR` 时会把 `.claude.json` 放进该目录。

### 6.2 MCP 读写

```ts
export function readClaudeMcpServers(): Record<string, unknown>;
export function writeClaudeMcpServers(next: Record<string, unknown>): void;
```

写入规则：

- 只读改写顶层 `mcpServers`，保留其他键；
- 文件存在但无法解析时**拒绝写入**，避免覆盖用户其它重要配置；
- 使用临时文件 + rename 的原子写入（`writeFileAtomicSync`）。

### 6.3 官方端点判断

```ts
export function isOfficialBaseUrl(baseUrl: string): boolean {
  if (!baseUrl.trim()) return true; // 空值按官方处理
  return new URL(baseUrl).hostname.toLowerCase() === "api.anthropic.com";
}
```

用于决定默认鉴权方式：官方 → `x-api-key`，第三方 → `Authorization: Bearer`。

---

## 7. settings.json 读写

文件：`src/main/agents/claude/settings.ts`

### 7.1 读取视图

`getClaudeSettingsView()` 返回 `AgentSettingsView`，字段映射：

| 视图字段 | settings.json 来源 |
|---|---|
| `baseUrl` | `env.ANTHROPIC_BASE_URL` |
| `apiKey` | `env.ANTHROPIC_AUTH_TOKEN` 或 `env.ANTHROPIC_API_KEY` |
| `apiKeyHint` | 脱敏：`••••` + 后 4 位 |
| `provider` | `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`，互斥 |
| `authMode` | `apiKeyHelper` > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` |
| `apiKeyHelper` | settings 顶层 `apiKeyHelper` |
| `customHeaders` | `env.ANTHROPIC_CUSTOM_HEADERS` |
| `httpsProxy` / `noProxy` | `env.HTTPS_PROXY` / `env.NO_PROXY` |
| `apiTimeoutMs` | `env.API_TIMEOUT_MS` |
| `maxOutputTokens` | `env.CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| `maxThinkingTokens` | `env.MAX_THINKING_TOKENS` |
| `disableNonessentialTraffic` | `env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` |
| `bedrockRegion` | `env.AWS_REGION` |
| `bedrockBaseUrl` | `env.ANTHROPIC_BEDROCK_BASE_URL` |
| `vertexProjectId` | `env.ANTHROPIC_VERTEX_PROJECT_ID` |
| `vertexRegion` | `env.CLOUD_ML_REGION` |
| `vertexBaseUrl` | `env.ANTHROPIC_VERTEX_BASE_URL` |
| `foundryResource` | `env.ANTHROPIC_FOUNDRY_RESOURCE` |
| `foundryBaseUrl` | `env.ANTHROPIC_FOUNDRY_BASE_URL` |
| `defaultModel` | `env.ANTHROPIC_MODEL` |
| `modelAliases.<alias>` | `env.ANTHROPIC_DEFAULT_<ALIAS>_MODEL` + `_NAME` |
| `permissionMode` | `permissions.defaultMode` |

### 7.2 模型 ID 格式

```ts
// "deepseek-flash[1M]" → { name: "deepseek-flash", context: "1M" }
function parseModelEntry(rawModel, rawName) { ... }

// { name: "deepseek-flash", context: "1M" } → "deepseek-flash[1M]"
function formatModelEntry(entry) { ... }
```

- `_MODEL` 存完整 ID（含上下文）；
- `_MODEL_NAME` 只存基础模型名；
- `modelCount` 按基础模型名去重统计。

### 7.3 写入规则

`saveClaudeSettings(draft)`：

- 只改 `env` 与 `permissions.defaultMode`，保留 hooks / plugins / statusLine 等；
- `apiKey` 语义：`undefined` 保持、`""` 清除、其他更新；
- `authMode` 决定落点：
  - `api-key` → `ANTHROPIC_API_KEY`（x-api-key）
  - `auth-token` → `ANTHROPIC_AUTH_TOKEN`（Bearer）
  - `api-key-helper` → settings 顶层 `apiKeyHelper`，不写 env key
- 三个 provider 开关互斥：设置一个时删除另外两个；
- 正整数校验：`API_TIMEOUT_MS` / `CLAUDE_CODE_MAX_OUTPUT_TOKENS` / `MAX_THINKING_TOKENS`；
- `permissionMode`：`manual` 归一为 `default`（settings 里叫 default，命令行开关叫 manual）；
- 原子写入。

### 7.4 `isEnvEnabled`

Claude Code 用同一套规则判断开关：空串 / `"0"` / `"false"` 视为关闭。读取时保持一致，避免页面显示已开启、CLI 实际没开。

---

## 8. 模型列表

文件：`src/main/agents/claude/models.ts`

### 8.1 请求

```
GET <baseUrl>/v1/models?limit=1000    // 首选
GET <baseUrl>/models?limit=1000       // 兜底：部分网关只在根路径提供
```

- Base URL 已带 `/v1` 时不重复拼；
- 误粘贴完整接口地址（`/v1/messages` 等）时先还原成根路径；
- 空 Base URL 用官方 `https://api.anthropic.com`；
- 请求头：
  - `accept: application/json`
  - `anthropic-version: 2023-06-01`
  - `auth-token` → `Authorization: Bearer <key>`
  - `api-key` → `x-api-key: <key>`
  - `ANTHROPIC_CUSTOM_HEADERS` 解析后追加
- 15 秒超时；
- 主进程发起，避免渲染层 CORS。

### 8.2 可选能力与降级

模型列表不是 Anthropic 协议的一部分，Claude Code 运行时也不依赖它：
很多兼容网关只实现 `/v1/messages`，`/v1/models` 会返回 404。此时

- 依次尝试候选地址；
- 全部 404 / 405 时返回空列表 + `unsupported` 说明；
- 界面把它展示为「可手动输入模型 ID」的中性提示，不当作配置错误。

`apiKeyHelper` 模式同理：无法代其请求模型列表，返回 `unsupported` 提示。

### 8.3 响应解析

兼容两种：

```json
{ "data": [{ "id": "claude-...", "display_name": "..." }] }
```

```json
{ "data": ["model-a", "model-b"] }
```

去重、过滤空 id、保留可选 `displayName`。

### 8.4 自定义请求头解析

```ts
export function parseCustomHeaders(raw: string): Record<string, string>;
```

每行 `Name: Value`，忽略空行与 `#` 注释。

---

## 9. 员工运行时投影

文件：`src/main/agents/claude/prepare.ts`（工作流）、`chat-runtime.ts`（聊天）、`employees/runtime.ts`（同步逻辑）

### 9.1 触发条件

```ts
// 工作流：只有绑定了数字员工的节点才准备员工运行时
if (input.mode !== "workflow" || !input.employee) return {};
```

聊天由 `prepareChatRun` 单独准备：未绑定员工时使用 base home，`@` 员工时把该员工的技能 / MCP 投影到会话 home。

### 9.2 目录结构

```
~/.novastudio/runtime/<employeeId>/
├── claude-home/
│   ├── settings.json        # 从 ~/.claude/settings.json 同步
│   ├── .credentials.json    # 从 ~/.claude/.credentials.json 同步（chmod 0600）
│   ├── skills/              # 只链接员工选中的技能
│   └── projects/            # CLI 会话 JSONL，--resume 的凭据
└── mcp.json                 # 只包含员工选中的 MCP
```

聊天会话的 home 在 `~/.novastudio/runtime/<sessionId>/employees/<employeeId>/`，与员工运行时共用同一套投影逻辑。

### 9.3 同步规则

1. `settings.json` / `.credentials.json` 按 mtime + size 比对，变化才覆盖；缺失时写 warning，并区分「没有凭证」与「已通过环境变量 / settingsKey / apiKeyHelper 认证」；
2. 技能：勾选项优先创建目录链接，失败（跨盘 / 权限）回退复制；解绑立即删除；
3. MCP：从全局 `~/.claude.json` 取定义，每次全量重写 `mcp.json`；空集也写，配合 `--strict-mcp-config` 阻断全局 MCP；
4. 同一员工的同步串行执行，避免聊天与工作流同时删建链接；
5. 旧版 `~/.novastudio/employee/<id>` / `employee-runtime/<id>` 在首次使用时迁移，`claude-home/projects` 整体保留。

### 9.4 返回

```ts
{
  configDir,
  env: { CLAUDE_CONFIG_DIR: configDir },
  extraArgs: ["--mcp-config", mcpConfigPath, "--strict-mcp-config"],
  warnings,
  injected: { mcpServers: [...], skills: [...] },
}
```

### 9.5 为什么用 `--strict-mcp-config`

防止全局 MCP 意外泄漏给节点。即使员工一个 MCP 都没选，也传空 `mcpServers`。

### 9.6 为什么 attempt 内配置目录稳定

人工审核「要求修改」需要在同一个 CLI 会话里续聊，因此 `configDir` 在整个 attempt 内保持不变，下一轮才能靠 `--resume` 找到会话文件。attempt 结束时只删除该会话的 JSONL，员工运行时目录作为共享环境继续保留；运行时可随时按数据库定义重建，唯一不可再生的是 `projects/`。

### 9.7 旧版内联 MCP

```ts
function inlineMcpDefinition(ref) {
  if (!ref.command?.trim()) return null;
  return {
    command: ref.command.trim(),
    args: splitArgs(ref.args ?? ""),
    env: parseKeyValueLines(ref.env ?? ""),
  };
}
```

`splitArgs` / `parseKeyValueLines` 来自 `shared/mcp.ts`，与 UI 预览共用同一套规则。

---

## 10. 运行现场配置摘要

`describeRuntimeConfig()` 返回给 `execution.md` 的键值：

- 配置文件路径；
- 默认模型（`name[context]`）；
- 权限模式；
- Base URL；
- API Key（脱敏提示）；
- 每个已配置的模型别名；
- 宿主环境里所有 `ANTHROPIC_*` / `CLAUDE_*` / `MCP_*` 变量：
  - 名字含 `token|secret|password|auth|api[-_]?key|access[-_]?key|credential` → `（已隐藏，长度 N）`
  - 其他 → 原值。

**为什么记录宿主环境**：宿主进程里的接入变量会继承给 CLI，经常是“配置没错但行为不对”的真正原因。

---

## 11. 版本探测

```ts
detect: () => probeVersion("claude")
```

执行 `claude --version`，10 秒超时，失败视为未安装。

---

## 12. 已知边界

1. **只支持 Claude Code**：`resolveAgentId()` 取第一个 provider。
2. **stream-json 协议随 CLI 版本变化**：解码器只覆盖当前已知字段；未知行忽略。
3. **会话目录大小写不稳定**：依赖全量扫描兜底。
4. **`--include-partial-messages` 可能增加事件量**：靠 16ms 批量与前端合批消化。
5. **系统提示词临时目录**：依赖 `os.tmpdir()` 可写；清理失败不影响运行。

---

## 13. 复刻验收清单

- [ ] 首次调用参数与 `--resume` 参数正确。
- [ ] prompt 走 stdin，系统提示词走临时文件。
- [ ] 未显式选择模型时，不传 `--model`；未识别权限模式时，不传 `--permission-mode`。
- [ ] stream-json 每行解析，session_id 可提取。
- [ ] assistant 按 message.id 归组，`message_end` 发累积全集。
- [ ] tool_result 到达时清空累积，避免重复。
- [ ] tool_use / tool_result 按 id 配对，result 补 name。
- [ ] result 错误子类型上报为 error。
- [ ] 会话 JSONL 定位支持快路径 + 全量扫描兜底。
- [ ] 会话 id 路径安全校验。
- [ ] 删除只删单个文件，不递归。
- [ ] settings.json 读写保留其他键，原子写入。
- [ ] 模型 ID 的 `[context]` 正确拆分 / 拼接。
- [ ] 工作流投影只复制员工选中的 Skill，MCP 用 `--strict-mcp-config`。
- [ ] 运行配置摘要脱敏。
