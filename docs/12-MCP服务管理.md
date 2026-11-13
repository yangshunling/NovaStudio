# 12 MCP 服务管理

## 1. 目的与边界

MCP（Model Context Protocol）服务定义统一存放在 Claude Code 的用户配置中：

```
~/.claude.json
{
  "mcpServers": {
    "<service-name>": {
      "command": "...",
      "args": [...],
      "env": { ... }
    }
  }
}
```

Nova 不维护自己的 MCP 库：

- 新增 / 修改 / 删除直接读写这份配置；
- Claude Code 终端与 Nova 共用同一套；
- 只扫描**用户级顶层** `mcpServers`；
- 项目级 local scope（`projects[<dir>].mcpServers`）与项目 `.mcp.json` 不纳入 Nova 全局库；
- 设置 `CLAUDE_CONFIG_DIR` 时路径变为 `$CLAUDE_CONFIG_DIR/.claude.json`（见 `src/main/agents/claude/config.ts`）。

---

## 2. 数据模型

```ts
export type McpTransport = "stdio" | "http" | "sse";
export type McpSource = "claude-global";

export interface McpServerAsset {
  id: string;              // `claude-global:<service-name>`
  slug: string;            // service-name
  name: string;
  description: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  path: string;            // ~/.claude.json
  source: McpSource;
  definition: Record<string, unknown>; // mcpServers[name] 原始对象
  hasSecrets: boolean;
  valid: boolean;
  problems: string[];
  updatedAt: number;
}
```

编辑表单：

```ts
export interface McpServerDraft {
  name: string;
  description: string;
  transport: McpTransport;
  command: string;
  args: string;      // 每行一个参数
  env: string;       // 每行 KEY=VALUE
  url: string;
  headers: string;   // 每行 KEY=VALUE
}
```

---

## 3. 解析

文件：`src/main/mcp/catalog.ts`

### 3.1 兼容多种写法

```ts
function parseServerObject(raw, fallbackName): ParsedServer {
  const value = raw ?? {};
  const url = toText(value.url);
  return {
    name: toText(value.name) || fallbackName,
    description: toText(value.description),
    transport: normalizeTransport(value.transport ?? value.type, url),
    command: toText(value.command),
    args: toStringArray(value.args),
    env: toRecord(value.env ?? value.environment),
    url,
    headers: toRecord(value.headers),
  };
}
```

支持：

- Nova 完整格式：`{ name, description, transport, command, args, env, url, headers }`
- Claude stdio：`{ command, args, env }`
- Claude remote：`{ type: "http", url, headers }`
- 字段别名：`type` → `transport`、`environment` → `env`

### 3.2 传输方式推断

```ts
function normalizeTransport(value, url) {
  const raw = value?.trim().toLowerCase() ?? "";
  if (["http","streamable-http","streamablehttp","remote"].includes(raw)) return "http";
  if (raw === "sse") return "sse";
  if (["stdio","local","command"].includes(raw)) return "stdio";
  return url.trim() ? "http" : "stdio";
}
```

很多配置只写 `url` 不写 `type`，按远程 HTTP 处理。

### 3.3 参数 / 环境变量

复用 `shared/mcp.ts`：

```ts
export function splitArgs(raw: string): string[];             // 支持单双引号
export function parseKeyValueLines(raw: string): Record<string,string>; // 忽略空行与 # 注释
export function formatKeyValue(record: Record<string,string>): string;
```

**为什么放 shared**：UI 预览和运行时注入必须对同一份 args/env 得出相同结果。

---

## 4. 校验

```ts
function validate(input): string[] {
  const problems = [];

  if (!input.name) problems.push("服务名不能为空");
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.name)) {
    problems.push("服务名只能包含字母、数字、点、下划线和连字符");
  }

  if (input.transport === "stdio") {
    if (!input.command.trim()) problems.push("stdio 服务必须填写启动命令");
  } else if (!/^https?:\/\//i.test(input.url.trim())) {
    problems.push(`${input.transport} 服务必须填写 http(s) URL`);
  }

  for (const key of Object.keys(input.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) problems.push(`环境变量名不合法：${key}`);
  }
  for (const key of Object.keys(input.headers)) {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) problems.push(`请求头名称不合法：${key}`);
  }

  return problems;
}
```

- `valid = problems.length === 0`；
- UI 用 `problems` 标记「需处理」。

### 4.1 含密钥判断

```ts
function hasLiteralSecrets(env, headers): boolean {
  return [...Object.values(env), ...Object.values(headers)].some(
    value => value.trim() !== "" && !/\$\{[^}]+\}/.test(value)
  );
}
```

- 值里包含 `${VAR}` → 视为环境注入，不标「含密钥」；
- 完全字面量 → 标记，提示用户注意。

---

## 5. 扫描

```ts
async function scanClaudeConfigs(): Promise<McpServerAsset[]> {
  const configPath = claudeUserConfigPath(); // ~/.claude.json 或 $CLAUDE_CONFIG_DIR/.claude.json
  if (!existsSync(configPath)) return [];

  const info = await stat(configPath);
  if (info.size > MAX_JSON_BYTES) return [];  // 5MB 上限
  const data = JSON.parse(await readFile(configPath, "utf8"));

  return serversFromConfig(data, {
    idPrefix: "claude-global",
    path: configPath,
    updatedAt: info.mtimeMs,
  });
}
```

- 只取顶层 `mcpServers`；
- `id = claude-global:<name>`；
- 按 `slug` 排序；
- 文件不存在 / 解析失败 / 超大 → 返回空数组，不抛错；
- 列表结果缓存 3 秒；新建 / 更新 / 删除 / 导入后主动失效。

---

## 6. 新建 / 更新 / 删除

### 6.1 保存流程

```ts
async function saveWithCatalog(id, draft, all) {
  const parsed = draftToParsed(draft);
  const problems = validate(parsed);
  if (problems.length) return { ok: false, error: problems.join("；") };

  let oldName = null;
  if (id) {
    const existing = all.find(s => s.id === id);
    if (!existing) return { ok: false, error: "MCP 服务不存在，可能已被删除" };
    oldName = existing.slug;
  }

  const definition = toClaudeServer(parsed);
  const written = commitMcpServer(oldName, parsed.name, definition);
  if (!written.ok) return written;

  return { ok: true, asset: savedAsset(parsed.name, parsed, definition) };
}
```

### 6.2 Claude 原生结构

```ts
function toClaudeServer(parsed) {
  if (parsed.transport === "stdio") {
    return { command: parsed.command, args: parsed.args, env: parsed.env };
  }
  return { type: parsed.transport, url: parsed.url, headers: parsed.headers };
}
```

### 6.3 写入与改名

```ts
function commitMcpServer(oldName, newName, value) {
  const servers = readClaudeMcpServers();
  const renamed = oldName !== null && oldName !== newName;

  if (oldName !== newName && servers has newName) {
    return { ok: false, error: `已存在同名 MCP 服务：${newName}` };
  }

  try {
    if (renamed) delete servers[oldName];
    servers[newName] = value;
    writeClaudeMcpServers(servers);
  } catch (err) {
    return { ok: false, error: message };
  }

  if (renamed) remapEmployeeMcpRefs(oldName, newName);
  return { ok: true };
}
```

`writeClaudeMcpServers`：

- 只改顶层 `mcpServers`，保留其他键；
- 文件存在但无法解析 → 拒绝写入；
- 原子写入（临时文件 + rename）。

### 6.4 改名同步员工

```ts
function remapEmployeeMcpRefs(oldName, newName) {
  for (const employee of db.listDigitalEmployees()) {
    let changed = false;
    const next = employee.mcpServers.map(ref => {
      const key = ref.assetId.includes(":")
        ? ref.assetId.slice(ref.assetId.indexOf(":") + 1)
        : ref.assetId || ref.name;
      if (key !== oldName) return ref;
      changed = true;
      return { ...ref, assetId: `claude-global:${newName}`, name: newName };
    });
    if (changed) db.updateEmployeeBindings(employee.id, JSON.stringify(next), JSON.stringify(employee.skills));
  }
}
```

### 6.5 删除同步员工

```ts
function dropEmployeeMcpRefs(name) {
  for (const employee of db.listDigitalEmployees()) {
    const next = employee.mcpServers.filter(ref => key(ref) !== name);
    if (next.length !== employee.mcpServers.length) {
      db.updateEmployeeBindings(employee.id, JSON.stringify(next), JSON.stringify(employee.skills));
    }
  }
}
```

**为什么**：删除资产后员工引用会失效，运行时只会 warning，容易造成“悄悄失去能力”。

### 6.6 原始 JSON 编辑

`saveMcpDefinition(id, name, definition)`：

- 用户直接编辑 `mcpServers[name]` 的 JSON；
- 服务名单独传入，校验命名规则；
- JSON 必须是对象；
- 改名时同样同步员工引用；
- **用户写什么，配置里就存什么**，不做字段拆解。

---

## 7. 导入

### 7.1 支持的形状

```ts
function collectImportEntries(raw) {
  // 1. 数组：[{ name?, ...config }, ...]
  if (Array.isArray(raw)) return raw.map((item, i) => [name || `mcp-${i+1}`, item]);

  // 2. { mcpServers: { name: config } }
  if (raw.mcpServers && typeof raw.mcpServers === "object") {
    return Object.entries(raw.mcpServers);
  }

  // 3. 单个服务对象
  return [[raw.name || "mcp-server", raw]];
}
```

### 7.2 批量导入

```ts
async function importMcpServers(json) {
  const entries = collectImportEntries(JSON.parse(json));
  const all = await listMcpServers();   // 一次扫描

  for (const [name, config] of entries) {
    const parsed = parseServerObject(config, name);
    const result = await saveWithCatalog(null, draftFrom(parsed), all);
    if (result.ok) { imported.push(result.asset); all.push(result.asset); }
    else errors.push(`${parsed.name}：${result.error}`);
  }
}
```

- 部分成功时 `ok: true` + `error: "部分失败：..."`；
- 全部失败时 `ok: false`。

### 7.3 从文件导入

`importMcpFromPath(filePath)`：

- 文件超过 5MB 拒绝；
- 读取后走 `importMcpServers`；
- IPC 层弹文件选择框。

---

## 8. 运行时注入

### 8.1 聊天

聊天按会话运行时投影 MCP：

- 未指定员工时，base home `~/.novastudio/runtime/<sessionId>/claude-home/` 写入**全部**全局 MCP，并传 `--mcp-config`（不传 `--strict-mcp-config`），项目 `.mcp.json` 仍可加载；
- `@` 员工时，员工 home `~/.novastudio/runtime/<sessionId>/employees/<employeeId>/claude-home/` 只写入该员工 `enabled` 的服务，并配合 `--strict-mcp-config` 阻断全局 / 项目 MCP 泄漏。

### 8.2 工作流节点

Claude provider 的 `prepareRun`（`src/main/agents/claude/prepare.ts` 委托 `employees/runtime.ts`）：

1. 读取全局 `readClaudeMcpServers()`；
2. 遍历员工 `mcpServers` 中 `enabled` 的项；
3. 新版 `assetId` → 从全局配置取定义；
4. 旧版内联 `command/args/env` → 直接渲染；
5. 缺失 → warning 并跳过；
6. 写 `~/.novastudio/runtime/<employeeId>/mcp.json`：

```json
{
  "mcpServers": {
    "service-a": { ... },
    "service-b": { ... }
  }
}
```

7. 通过命令行：

```
--mcp-config ~/.novastudio/runtime/<employeeId>/mcp.json
--strict-mcp-config
```

**即使一个都没选也写空对象**，配合 `--strict-mcp-config` 防止全局 MCP 泄漏给节点。

0.3.0 起不再为每个 attempt 创建临时投影目录：`mcp.json` 属于员工常驻 home，每次运行前按数据库幂等重写；技能 / MCP 都是派生物，运行结束不单独清理，删除员工时才随 `runtime/<employeeId>` 一起移除。

### 8.3 为什么用独立 mcp.json

- `--mcp-config` 精确指定本次可用的服务；
- `--strict-mcp-config` 让 CLI 忽略其他来源；
- 员工的“子集”语义才真正生效。

---

## 9. UI

`components/mcp/McpView.tsx`：

- 服务卡片：名称、命令 / 端点、传输方式、含密钥、校验状态、使用人数、更新时间；
- 详情：配置文件路径、使用情况、密钥提示、校验问题；
- 新建 / 编辑：服务名 + `mcpServers[name]` 的原始 JSON 定义（不再提供 stdio / 远程字段表单）；
- 删除：提示受影响的员工数；删除后同步移除员工引用；
- 导入：粘贴 JSON / 选择文件；
- 打开配置文件。

`components/mcp/presentation.ts` 提供展示辅助（标签、图标、摘要）。

---

## 10. 关键文件索引

| 功能 | 文件 |
|---|---|
| 资产读写 | `src/main/mcp/catalog.ts` |
| Claude 配置 | `src/main/agents/claude/config.ts` |
| 运行时投影 | `src/main/agents/claude/prepare.ts` |
| IPC | `src/main/ipc/handlers/mcp.ts` |
| 纯函数 | `src/shared/mcp.ts` |
| UI | `src/renderer/components/mcp/McpView.tsx`、`presentation.ts` |

---

## 11. 复刻验收清单

- [ ] 所有 MCP 定义只存 `~/.claude.json` 顶层 `mcpServers`。
- [ ] 不扫描项目级 scope 与 `.mcp.json`。
- [ ] 支持 stdio / http / sse，兼容 `type` / `url` 推断。
- [ ] 服务名校验：字母数字开头，允许 `. _ -`。
- [ ] stdio 必须有 command；远程必须是 http(s) URL。
- [ ] env 变量名 / header 名称校验。
- [ ] `${VAR}` 占位符不标含密钥，字面量才标。
- [ ] 新建 / 更新 / 删除直接写回配置，保留其他键。
- [ ] 配置无法解析时拒绝写入。
- [ ] 改名同步员工引用；删除移除员工引用。
- [ ] 支持单对象 / 数组 / `{mcpServers}` 三种导入形状。
- [ ] 工作流节点只注入员工选中的服务，使用 `--strict-mcp-config`。
- [ ] 一个都没选也写空 `mcpServers`。
- [ ] 聊天 base 环境使用全部全局 MCP；`@` 员工时只注入员工勾选的服务并加 `--strict-mcp-config`。
- [ ] 运行时目录为 `~/.novastudio/runtime/<employeeId>/`，不再生成 attempt 级临时投影。
