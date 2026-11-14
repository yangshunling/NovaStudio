/**
 * Agent 契约层
 *
 * 只描述「宿主需要知道的关于 Agent 的事」，不含任何具体 CLI 的实现细节。
 *
 * 分工：
 * - AgentManifest：静态元数据，与「本机是否安装」无关，主进程与渲染进程共享。
 * - AgentCapabilities：能力声明，宿主据此改变自身行为（而非靠猜或特判 id）。
 * - AgentStatus：运行时检测结果。
 * - AgentInfo：manifest + status + 本机配置信息的合并视图，UI 只消费这一个结构。
 *
 * 设计前提：Nova 不再维护 Agent 自己的接入配置（Base URL / Key / 模型），
 * 直接复用各 CLI 本机安装后的配置。这里只保留「状态」和「配置位置」。
 */

/**
 * Agent 能力声明。
 *
 * 只声明「宿主会据此改变行为」的能力。
 */
export interface AgentCapabilities {
  /**
   * 是否支持恢复历史会话（多轮）。
   * false 时宿主不持久化会话引用，每次调用都作为新会话发起。
   */
  resume: boolean;
  /**
   * 会话数据是否存放在 CLI 侧、需要宿主在删除会话时同步清理。
   * false 时宿主不会调用 provider 的 deleteSession。
   */
  sessionCleanup: boolean;
  /**
   * 宿主是否支持按员工选择/加载该 Agent 的 skills。
   * false 时员工侧不显示技能页签，运行时忽略技能绑定。
   */
  skills: boolean;
  /** 宿主是否支持按员工选择/加载该 Agent 的 MCP 服务。 */
  mcp: boolean;
}

/**
 * Agent 标识色槽位。
 *
 * 只声明「用哪个槽位」，具体色值由皮肤层提供（--c-agent-<tone>）。
 */
export type AgentTone = "amber" | "violet" | "sky" | "teal" | "rose" | "lime";

/** 静态元数据：与本机安装状态无关。 */
export interface AgentManifest {
  /** 唯一标识，与 sessions.agent_id 落库的值一致 */
  id: string;
  /** 展示名 */
  displayName: string;
  /** 列表排序权重，小的在前 */
  order: number;
  /** 标识色槽位 */
  tone?: AgentTone;
  capabilities: AgentCapabilities;
  /** 未安装时展示的安装命令；缺省表示未提供 */
  installCommand?: string;
}

/** 运行时检测结果 */
export interface AgentStatus {
  installed: boolean;
  version?: string;
}

/**
 * 一次升级检测结果。
 *
 * 检测失败不应阻止升级：`error` 有值时 UI 仍可展示 `installedVersion`，
 * 并允许用户直接尝试升级（由 CLI 自己判断是否有新版本）。
 */
export interface AgentUpgradeCheck {
  /** 当前安装版本；未安装时为空 */
  installedVersion?: string;
  /** 能获取到的最新版本；获取失败时为空 */
  latestVersion?: string;
  /** 已安装且确实存在更新的版本 */
  updateAvailable: boolean;
  /** 版本来源说明（如 npm registry） */
  source?: string;
  /** 检查失败原因 */
  error?: string;
}

/** 一次升级操作的结果 */
export interface AgentUpgradeResult {
  ok: boolean;
  /** 升级前版本 */
  previousVersion?: string;
  /** 升级后探测到的版本 */
  version?: string;
  /** 升级命令输出（已截断，用于排查失败原因） */
  output?: string;
  error?: string;
}

/**
 * 一次安装操作的结果。
 *
 * 安装是「从无到有」：没有 previousVersion；失败时 output 里保留
 * npm 的原始输出，供界面直接展示排查。
 */
export interface AgentInstallResult {
  ok: boolean;
  /** 安装后探测到的版本 */
  version?: string;
  /** 安装命令输出（已截断，用于排查失败原因） */
  output?: string;
  error?: string;
}

/**
 * manifest + status + 本机配置信息的合并视图，UI 只消费这一个结构。
 */
export interface AgentInfo extends AgentManifest {
  status: AgentStatus;
  /**
   * 本机配置目录 / 文件路径；null 表示该 Agent 没有可展示的固定路径。
   * Nova 不修改它，只用于状态展示和「打开目录」。
   */
  configPath: string | null;
  /** 配置路径当前是否存在 */
  configExists: boolean;
  /** 配置来源说明（例如“直接使用本机 Claude Code 配置”） */
  configNote?: string;
}

// ============================================================================
// 本机配置编辑（当前由 Claude Code 支持）
// ============================================================================

/** Claude 的模型别名槽位 */
export type AgentModelAlias = "fable" | "opus" | "sonnet" | "haiku";

/**
 * Claude Code 的接入端点类型。
 *
 * 字段映射（settings.json → env）：
 * - anthropic → 不设 CLAUDE_CODE_USE_*，走 ANTHROPIC_BASE_URL
 * - bedrock   → CLAUDE_CODE_USE_BEDROCK = "1"
 * - vertex    → CLAUDE_CODE_USE_VERTEX = "1"
 * - foundry   → CLAUDE_CODE_USE_FOUNDRY = "1"
 */
export type AgentProvider = "anthropic" | "bedrock" | "vertex" | "foundry";

/**
 * API Key 的落点。Claude Code 认三个来源：
 * - api-key         → env.ANTHROPIC_API_KEY（请求头 x-api-key）
 * - auth-token      → env.ANTHROPIC_AUTH_TOKEN（请求头 Authorization: Bearer）
 * - api-key-helper  → settings.json 顶层 apiKeyHelper（命令输出 key 到 stdout）
 */
export type AgentAuthMode = "api-key" | "auth-token" | "api-key-helper";

/**
 * 别名槽位的唯一来源。
 *
 * 新增 / 调整别名时只改这里：设置读写、模型设置页与环境变量命名都从这里推导，
 * 避免三处列表各自漏改导致“页面上能选、保存时被丢弃”。
 */
export const AGENT_MODEL_ALIASES: readonly AgentModelAlias[] = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
];

/**
 * 一个模型配置。
 *
 * Claude 的模型 ID 可能带上下文后缀，例如 `deepseek-flash[1M]`；
 * 其中 `[1M]` 是上下文配置，不是模型名。UI 必须拆开显示与编辑。
 */
export interface AgentModelEntry {
  /** 基础模型名，不含 `[1M]` 之类的上下文后缀 */
  name: string;
  /** 上下文配置，例如 "1M"；空字符串表示不追加 */
  context: string;
}

/**
 * 从 Claude 本机 settings.json 读出的配置视图。
 * 修改会直接写回同一份文件，Claude CLI 与 Nova 共用。
 */
export interface AgentSettingsView {
  agentId: string;
  /** ~/.claude/settings.json */
  settingsPath: string;
  /** 配置文件当前是否存在 */
  exists: boolean;
  baseUrl: string;
  /** 明文 Key：仅用于本地配置页展示 / 编辑 */
  apiKey: string;
  hasApiKey: boolean;
  apiKeyHint: string;

  // === 接入方式 ===
  /** 由 env.CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY 推导 */
  provider: AgentProvider;
  /** 由实际存在的 key 槽位 / apiKeyHelper 推导 */
  authMode: AgentAuthMode;
  /** settings.json 顶层 apiKeyHelper（命令，输出 key 到 stdout） */
  apiKeyHelper: string;

  /** env.ANTHROPIC_CUSTOM_HEADERS，每行 `Name: Value` */
  customHeaders: string;

  // === 网络 ===
  /** env.HTTPS_PROXY */
  httpsProxy: string;
  /** env.NO_PROXY */
  noProxy: string;
  /** env.API_TIMEOUT_MS（毫秒） */
  apiTimeoutMs: string;

  // === 运行限制 ===
  /** env.CLAUDE_CODE_MAX_OUTPUT_TOKENS */
  maxOutputTokens: string;
  /** env.MAX_THINKING_TOKENS */
  maxThinkingTokens: string;
  /** env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC */
  disableNonessentialTraffic: boolean;

  // === 云厂商专属 ===
  /** env.AWS_REGION（Bedrock） */
  bedrockRegion: string;
  /** env.ANTHROPIC_BEDROCK_BASE_URL（Bedrock，可选） */
  bedrockBaseUrl: string;
  /** env.ANTHROPIC_VERTEX_PROJECT_ID（Vertex） */
  vertexProjectId: string;
  /** env.CLOUD_ML_REGION（Vertex） */
  vertexRegion: string;
  /** env.ANTHROPIC_VERTEX_BASE_URL（Vertex，可选） */
  vertexBaseUrl: string;
  /** env.ANTHROPIC_FOUNDRY_RESOURCE（Foundry） */
  foundryResource: string;
  /** env.ANTHROPIC_FOUNDRY_BASE_URL（Foundry，可选） */
  foundryBaseUrl: string;
  defaultModel: AgentModelEntry;
  /** 别名槽位 → 模型配置 */
  modelAliases: Record<AgentModelAlias, AgentModelEntry>;
  /** 去重后的模型数量（按基础模型名统计） */
  modelCount: number;
  /**
   * Claude settings 的 permissions.defaultMode。
   *
   * 作为新会话 / 工作流节点的默认权限；会话建立后会快照到会话记录，
   * 输入框工具栏可以按会话覆盖（通过 `--permission-mode` 显式传入，
   * 不写回本文件）。未配置时为 `bypassPermissions`。
   */
  permissionMode: string;
}

/** 从 Base URL 的 /v1/models 拉取到的模型；value 使用 id */
export interface AgentModelOption {
  id: string;
  /** 服务端返回的展示名；与 id 相同时可忽略 */
  displayName?: string;
}

export interface AgentSettingsDraft {
  agentId: string;
  baseUrl: string;
  /** undefined = 保持原值；"" = 清除；其他 = 更新 */
  apiKey?: string;
  /** 不传时按 Base URL 自动推断，兼容旧调用方 */
  authMode?: AgentAuthMode;
  defaultModel: AgentModelEntry;
  modelAliases: Record<AgentModelAlias, AgentModelEntry>;
  permissionMode: string;

  provider?: AgentProvider;
  apiKeyHelper?: string;
  customHeaders?: string;
  httpsProxy?: string;
  noProxy?: string;
  apiTimeoutMs?: string;
  maxOutputTokens?: string;
  maxThinkingTokens?: string;
  disableNonessentialTraffic?: boolean;
  bedrockRegion?: string;
  bedrockBaseUrl?: string;
  vertexProjectId?: string;
  vertexRegion?: string;
  vertexBaseUrl?: string;
  foundryResource?: string;
  foundryBaseUrl?: string;
}
