# 20 设置与 Agent 配置

## 1. 目的与边界

本层覆盖两类配置：

1. **应用设置**：字号、皮肤、默认 Agent / 工作目录、自动化并发 / 轮询 / 超时；
2. **Agent 本机配置**：直接编辑 `~/.claude/settings.json` 的接入、模型、权限、网络与运行限制。

不包含：

- MCP（`~/.claude.json`，见 12）；
- Skill（`~/.claude/skills`，见 13）；
- 知识库（见 14）。

---

# 第一部分：应用设置

## 2. 数据模型

```ts
export interface AppSettings {
  defaultAgent: string;
  defaultCwd: string;
  theme: string;
  fontSize: number;
  chatFontSize: number;
  terminalFontSize: number;
  automationConcurrency: number;
  automationPollIntervalSec: number;
  agentTimeoutMinutes: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultAgent: "",
  defaultCwd: "",
  theme: "",
  fontSize: 13,
  chatFontSize: 13,
  terminalFontSize: 15,
  automationConcurrency: 3,
  automationPollIntervalSec: 30,
  agentTimeoutMinutes: 30,
};
```

存储：SQLite `settings` 表（键值字符串）。

---

## 3. 编解码表

文件：`src/main/ipc/handlers/settings.ts`

```ts
const SETTING_CODECS: {
  [K in keyof AppSettings]: {
    encode: (value: AppSettings[K]) => string;
    decode: (raw: string) => AppSettings[K];
  };
} = {
  defaultAgent: { encode: String, decode: raw => raw },
  defaultCwd: { encode: String, decode: raw => raw },
  theme: { encode: String, decode: raw => raw },
  fontSize: { encode: String, decode: raw => Number(raw) },
  chatFontSize: { encode: String, decode: raw => Number(raw) },
  terminalFontSize: { encode: String, decode: raw => Number(raw) },
  automationConcurrency: { encode: String, decode: raw => Number(raw) },
  automationPollIntervalSec: { encode: String, decode: raw => Number(raw) },
  agentTimeoutMinutes: { encode: String, decode: raw => Number(raw) },
};

const SETTING_KEYS = Object.keys(SETTING_CODECS) as (keyof AppSettings)[];
```

**新增一个设置项**：只需在 `AppSettings` 加字段 + 在 `SETTING_CODECS` 加一行；类型约束会提示漏写。

---

## 4. 数值夹紧

IPC 是进程边界，不能假设调用方来自本项目界面。

```ts
const INTEGER_LIMITS = {
  fontSize: [8, 64],
  chatFontSize: [8, 64],
  terminalFontSize: [8, 64],
  automationConcurrency: [1, 10],
  automationPollIntervalSec: [5, 600],
  agentTimeoutMinutes: [1, 1440],
};
```

`sanitizeSetting`：

- 非有限数 → `undefined`（由调用方报错）；
- 四舍五入后夹在区间内；
- 字符串型只 `trim`，空串合法（表示未指定）；
- 类型不对 → `undefined`，明确报错，不悄悄丢弃。

### 4.1 先全量校验再落库

```ts
handle("settings:set", (patch) => {
  const entries = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const codec = SETTING_CODECS[key];
    if (!codec) throw new Error(`未知的设置项：${key}`);
    const sanitized = sanitizeSetting(key, value);
    if (sanitized === undefined) throw new Error(`设置项「${key}」的取值无效`);
    entries.push({ key, value: codec.encode(sanitized) });
  }
  for (const entry of entries) db.setSetting(entry.key, entry.value);
  return true;
});
```

**为什么**：某个键非法时直接报错，而不是丢掉后仍返回成功——否则用户以为生效了，重启才发现没变。

---

## 5. 原生外观

```ts
handle("window:setAppearance", ({ appearance }) => {
  nativeTheme.themeSource = appearance;
  return true;
});
```

渲染层每次应用皮肤都会把 `appearance` 同步过来，Windows 标题栏 / 系统控件即时切换。

---

## 6. 渲染层设置

`components/app/SettingsModal.tsx` 只负责左侧导航与面板切换，内容拆在 `components/settings/`：

| 分组 | 文件 | 控件 |
|---|---|---|
| 通用 | `GeneralPanel.tsx` | 默认 Agent、默认工作目录 |
| 外观 | `AppearancePanel.tsx` | 皮肤、界面字体、界面字号、聊天字号 |
| 终端 | `TerminalPanel.tsx` | 终端字号 |
| 自动化 | `AutomationPanel.tsx` | 并发数 1–10、轮询间隔、单次超时 |
| 关于与更新 | `AboutPanel.tsx` | 版本 / 运行时信息、检查 / 下载 / 安装 |

- 布局统一为 `SettingsPage` + `SettingsCard` + `SettingsRow`：页头说明分组，卡片内按行排列，左侧名称与提示、右侧控件；
- 字号写入 `useThemeStore`，立即应用并持久化；
- 皮肤切换也在此面板（侧栏不再有昼夜按钮）；
- 并发 / 轮询 / 超时读写主进程设置；
- 更新状态订阅 `updater:changed`；
- 关于信息来自 `app:info`。

---

## 7. 默认值的使用

| 设置 | 使用位置 |
|---|---|
| `defaultAgent` | `detectAgents` 恢复上次选择；工作流 `resolveAgentId` 目前取第一个 provider |
| `defaultCwd` | `session:create` / `automation` 的 `resolveCwd` 回退 |
| `theme` | 启动时 `loadSkinSettings` |
| `fontSize` | `applyFontSize` |
| `chatFontSize` | `applyChatFontSize` |
| `terminalFontSize` | `TerminalView` |
| `automationConcurrency` | `scheduler.concurrencyLimit` |
| `automationPollIntervalSec` | `scheduler.pollIntervalMs` |
| `agentTimeoutMinutes` | `AgentService.resolveTimeoutMs` + `line-run` |

---

# 第二部分：Agent 配置

## 8. 设计原则

Nova 不维护自己的 Agent 接入配置：

- 登录、模型、权限全部复用 `~/.claude`；
- 「Agent 配置」页直接编辑 `~/.claude/settings.json`；
- 保存只改 `env` 与 `permissions.defaultMode`，保留 hooks / plugins / statusLine 等；
- 旧版 `~/.novastudio/agent-connections` 会在启动时迁移并归档。

---

## 9. 读取视图

`getClaudeSettingsView()` 返回 `AgentSettingsView`，字段映射详见 `06-Claude-Code适配层` 第 7 节。

关键点：

- `apiKey` 取 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`；
- `apiKeyHint` 脱敏为 `••••` + 后 4 位；
- `provider` 由 `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` 推导，互斥；
- `authMode` 优先级：`apiKeyHelper` > `AUTH_TOKEN` > `API_KEY`；
- 模型 ID 的 `[context]` 后缀拆成 `{ name, context }`；
- `modelCount` 按基础模型名去重。

---

## 10. 保存

`saveClaudeSettings(draft)`：

1. 读取 `settings.json`（无法解析时拒绝写入）；
2. 规范化 Base URL（只接受 http/https）；
3. 写 `ANTHROPIC_BASE_URL` 或删除；
4. 三个 provider 开关互斥；
5. API Key 落点：
   - `api-key` → `ANTHROPIC_API_KEY`
   - `auth-token` → `ANTHROPIC_AUTH_TOKEN`
   - `api-key-helper` → 顶层 `apiKeyHelper`
6. 默认模型 + 四个别名（`_MODEL` 完整 ID，`_MODEL_NAME` 基础名）；
7. 网络 / 运行限制 / 云厂商字段；
8. `permissions.defaultMode`；
9. 原子写回。

### 10.1 `apiKey` 语义

| 值 | 行为 |
|---|---|
| `undefined` | 保持原值 |
| `""` | 清除 |
| 其他 | 更新 |

### 10.2 权限模式

```ts
function normalizePermissionMode(value) {
  if (!value?.trim()) return "default";
  const trimmed = value.trim();
  return trimmed === "manual" ? "default" : trimmed; // settings 里叫 default，命令行叫 manual
}
```

### 10.3 正整数校验

`API_TIMEOUT_MS` / `CLAUDE_CODE_MAX_OUTPUT_TOKENS` / `MAX_THINKING_TOKENS`：

- 空串 → 删除；
- 非 `^\d+$` 或 ≤0 → 报错；
- 否则转字符串写入。

---

## 11. 模型列表

`listClaudeModels(baseUrl, apiKey, authMode, customHeaders)`：

- `GET <baseUrl>/v1/models?limit=1000`；
- Base URL 已带 `/v1` 不重复拼；
- 空 Base URL 用官方 `https://api.anthropic.com`；
- 鉴权方式与 CLI 实际请求头一致：
  - `auth-token` → `Authorization: Bearer`
  - `api-key` → `x-api-key`
- `apiKeyHelper` 模式直接报错；
- 15 秒超时；
- 兼容 `data: [{id, display_name}]` 与 `data: [string]`；
- 去重、过滤空 id。

---

## 12. Agent 检测

`agent:detect`：

```ts
const providers = listProviders();
const statuses = await Promise.all(providers.map(p => p.detect()));
return providers.map((p, i) => ({
  ...p.manifest,
  status: statuses[i],
  ...(p.configInfo?.() ?? { configPath: null, configExists: false }),
}));
```

- 并行检测；
- 失败视为未安装；
- 返回 manifest + status + 配置路径；
- 推送 `agents:detected`。

Claude 检测：`claude --version`，10 秒超时。

### 12.1 版本检查与升级

- `agent:upgrade:check` → `provider.checkUpgrade()`，无副作用；
- `agent:upgrade:run` → `provider.upgrade(onProgress)`，过程文本经 `agent:upgrade:progress` 推送；
- 升级入口在数字员工页的 Agent 配置链路中，不再与员工列表耦合；
- 未实现升级能力的 provider 不展示入口。

---

## 13. 配置迁移

`migration/legacy-assets.ts`：

- 旧 MCP：`~/.novastudio/mcp/*.json` → `~/.claude.json` 顶层 `mcpServers`；
- 旧 Skill：`~/.novastudio/skills/*` → `~/.claude/skills`；
- 旧 Agent 连接：`~/.novastudio/agent-connections` 归档；
- 员工引用从 `library:<slug>` 重映射为 `claude-global:<key>`；
- 迁移后旧目录移到 `~/.novastudio/legacy-assets/<时间戳>`；
- 幂等：旧目录不存在则跳过；
- 冲突（Claude 已有同名）跳过并保留旧数据。

---

## 14. 关键文件索引

| 功能 | 文件 |
|---|---|
| 设置类型 | `src/shared/types.ts` |
| 设置 IPC | `src/main/ipc/handlers/settings.ts` |
| 设置弹框 | `src/renderer/components/app/SettingsModal.tsx` |
| 设置面板 | `src/renderer/components/settings/*` |
| 主题 hook | `src/renderer/hooks/useTheme.ts` |
| Claude 配置读写 | `src/main/agents/claude/settings.ts` |
| Claude 模型列表 | `src/main/agents/claude/models.ts` |
| 配置路径 | `src/main/agents/claude/config.ts` |
| Agent IPC | `src/main/ipc/handlers/agent.ts` |
| 迁移 | `src/main/migration/legacy-assets.ts` |

---

## 15. 复刻验收清单

- [ ] `AppSettings` 字段与默认值一致。
- [ ] 设置以字符串存 SQLite，编解码集中。
- [ ] 数值设置夹紧在合法区间。
- [ ] `settings:set` 先全量校验再落库，非法键报错。
- [ ] `window:setAppearance` 驱动 `nativeTheme`。
- [ ] 字号修改立即生效并持久化。
- [ ] Agent 配置直接读写 `~/.claude/settings.json`。
- [ ] 只改 `env` 与 `permissions.defaultMode`，保留其他键。
- [ ] 原子写入；无法解析时拒绝写入。
- [ ] 模型 ID 的 `[context]` 正确拆分 / 拼接。
- [ ] 鉴权方式与 CLI 请求头一致。
- [ ] 模型列表兼容对象 / 字符串数组。
- [ ] 旧版 Agent 连接 / MCP / Skill 迁移幂等。
- [ ] 检测并行，失败视为未安装。
- [ ] 设置弹框为通用 / 外观 / 终端 / 自动化 / 关于五个独立面板。
- [ ] 皮肤切换位于外观面板，侧栏不再提供昼夜按钮。
- [ ] Agent 升级检查 / 执行可用，进度实时展示。
