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
 * 运行参数的声明式描述。
 *
 * 宿主只负责「按声明渲染表单 + 原样传回键值」，不解释任何键的含义，
 * 也不硬编码任何具体参数 —— 参数名到命令行开关的映射由 provider 自己做。
 *
 * 注意：模型不再作为可配置参数暴露；各 CLI 使用自己配置里的默认模型。
 */
export interface AgentOptionField {
  /** 宿主存取用的键；provider 负责把它映射到自己的命令行开关 */
  key: string;
  /** 表单标签 */
  label: string;
  /** 一句话说明，展示在控件下方 */
  hint?: string;
  /** text = 自由输入；select = 从 choices 里选 */
  type: "text" | "select";
  /** type=select 时的候选项 */
  choices?: readonly string[];
  /** 缺省值；缺省表示该项默认不传，由 CLI 自己决定 */
  defaultValue?: string;
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
  /** 运行参数声明；缺省或空数组表示该 Agent 没有可调参数 */
  options?: readonly AgentOptionField[];
  /** 未安装时展示的安装命令；缺省表示未提供 */
  installCommand?: string;
}

/** 运行时检测结果 */
export interface AgentStatus {
  installed: boolean;
  version?: string;
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
  defaultModel: AgentModelEntry;
  /** 别名槽位 → 模型配置 */
  modelAliases: Record<AgentModelAlias, AgentModelEntry>;
  /** 去重后的模型数量（按基础模型名统计） */
  modelCount: number;
  /** Claude settings 的 permissions.defaultMode */
  permissionMode: string;
}

export interface AgentSettingsDraft {
  agentId: string;
  baseUrl: string;
  /** undefined = 保持原值；"" = 清除；其他 = 更新 */
  apiKey?: string;
  defaultModel: AgentModelEntry;
  modelAliases: Record<AgentModelAlias, AgentModelEntry>;
  permissionMode: string;
}
