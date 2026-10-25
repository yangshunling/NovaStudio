/**
 * Agent 契约层
 *
 * 只描述「宿主需要知道的关于 Agent 的事」，不含任何具体 CLI 的实现细节。
 *
 * 分工：
 * - AgentManifest：静态元数据，与「本机是否安装」无关，主进程与渲染进程共享。
 * - AgentCapabilities：能力声明，宿主据此改变自身行为（而非靠猜或特判 id）。
 * - AgentStatus：运行时检测结果。
 * - AgentInfo：manifest + status 的合并视图，UI 只消费这一个结构。
 *
 * 新增一个 Agent：只需新增 src/main/agents/<id>/（实现 AgentProvider）并导出
 * 一份 manifest，engine、ipc、UI 与本文件均无需改动。
 */

/**
 * Agent 能力声明。
 *
 * 只声明「宿主会据此改变行为」的能力 —— 没有消费方的字段不放进来，
 * 避免重蹈「定义了却没人用」的死配置（如旧的 ToolInfo.path）。
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
   * 宿主是否支持把员工绑定的技能物化到该 Agent 的配置。
   * false 时 UI 会提示「暂未实现」，运行时跳过并记录告警。
   */
  skills: boolean;
  /** 宿主是否支持把员工绑定的 MCP 服务渲染给该 Agent。 */
  mcp: boolean;
}

/**
 * 运行参数的声明式描述。
 *
 * 宿主只负责「按声明渲染表单 + 原样传回键值」，不解释任何键的含义，
 * 也不硬编码任何具体参数 —— 参数名到命令行开关的映射由 provider 自己做。
 * 因此新增一个 Agent 时带上自己的一整套参数，宿主、IPC、UI 零改动。
 */
export interface AgentOptionField {
  /** 宿主存取用的键；provider 负责把它映射到自己的命令行开关 */
  key: string;
  /** 表单标签 */
  label: string;
  /** 一句话说明，展示在控件下方 */
  hint?: string;
  /**
   * text = 自由输入；select = 从 choices 里选；
   * model = 从该 Agent 动态获取的模型列表里选（获取失败时回退为自由输入）
   */
  type: "text" | "select" | "model";
  /** type=select 时的候选项 */
  choices?: readonly string[];
  /** 缺省值；缺省表示该项默认不传，由 CLI 自己决定 */
  defaultValue?: string;
}

/**
 * Agent 标识色槽位。
 *
 * 只声明「用哪个槽位」，具体色值由皮肤层提供（--c-agent-<tone>），
 * 因此新增一个 Agent 时挑一个尚无人占用的槽位即可 ——
 * 皮肤、组件、IPC 都不用改，且换肤后标识色自动融入该皮肤的调色。
 * 缺省（不声明）表示用中性灰。
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
  /**
   * 标识色槽位。同一台机器上并存多个 Agent 时靠它区分
   * （侧栏会话标记、看板任务标记、选择器）。
   */
  tone?: AgentTone;
  capabilities: AgentCapabilities;
  /** 运行参数声明；缺省或空数组表示该 Agent 没有可调参数 */
  options?: readonly AgentOptionField[];
}

/** 运行时检测结果 */
export interface AgentStatus {
  installed: boolean;
  version?: string;
}

/**
 * Agent 当前可选的模型项。
 *
 * 由各 provider 从自己的 CLI 或接口动态获取（命令、接口、回退别名各不相同），
 * 宿主只负责展示下拉并原样回传 value。
 */
export interface AgentModelOption {
  /** 传给该 Agent `--model` 的值 */
  value: string;
  /** 下拉展示名 */
  label: string;
  /** 补充说明（如 provider / 上下文窗口），可选 */
  hint?: string;
  /**
   * 若该项来自 Claude 的 `ANTHROPIC_DEFAULT_*_MODEL` 别名映射，
   * 记录别名（fable / opus / sonnet / haiku）。运行时据此注入映射，
   * 兼容老员工里保存的别名值。
   */
  alias?: string;
}

/** manifest + status 的合并视图，UI 只消费这一个结构 */
export interface AgentInfo extends AgentManifest {
  status: AgentStatus;
}

// ============================================================================
// 连接配置（Nova 自管，与数字员工 / 工作流运行时共用）
// ============================================================================

/**
 * Agent 连接的脱敏视图。
 *
 * 密钥本身永远不返回渲染层：只给出是否已保存、脱敏尾号和存储方式。
 * 运行时的真实密钥由主进程在启动子进程时解密并注入环境变量。
 */
export interface AgentConnection {
  agentId: string;
  /** 接口根地址；空字符串表示使用官方默认端点 */
  baseUrl: string;
  /** 数字员工未显式指定模型时使用的默认模型 */
  defaultModel: string;
  /** 最近一次从接口查询到的模型（缓存，供下拉快速展示） */
  models: AgentModelOption[];
  /** 是否已保存 API Key */
  hasApiKey: boolean;
  /** 脱敏提示，如 "••••abcd"；未保存时为空字符串 */
  apiKeyHint: string;
  /** 密钥存储方式：标准配置文件中的明文 / 未保存（encrypted 仅用于旧数据迁移） */
  keyStorage: "encrypted" | "plaintext" | "none";
  /**
   * 库里存了密钥、但当前设备无法解密（常见于从其他设备复制数据库或还原备份）。
   * UI 必须提示用户重新填写，而不是静默显示为“未配置”。
   */
  keyUnreadable: boolean;
  /** 本机是否存在可直接复制的 Claude OAuth 凭证 */
  oauthAvailable: boolean;
  /**
   * 保存时生成的标准 Claude 配置文件路径。
   * 该文件是节点运行时的配置来源（包含明文 API Key）。
   */
  settingsPath: string;
  /** 模型缓存时间 */
  modelsUpdatedAt: number | null;
  /** 配置最后保存时间；null 表示从未保存 */
  updatedAt: number | null;
}

/** 保存连接配置的入参 */
export interface AgentConnectionDraft {
  agentId: string;
  baseUrl: string;
  defaultModel: string;
  /**
   * 密钥更新语义：
   * - undefined：保持已保存的值不变（表单留空时的默认行为）
   * - ""：清除已保存的密钥
   * - 其他：写入新密钥
   */
  apiKey?: string;
  /** 与表单一起落库的模型缓存；省略则保持原值 */
  models?: AgentModelOption[];
}

/** 连接探测 / 连通性测试入参 */
export interface AgentConnectionProbeInput {
  agentId: string;
  baseUrl: string;
  /** 空字符串或省略时使用已保存的密钥 */
  apiKey?: string;
  /** 需要顺带验证的模型名；空字符串表示只验证连接 */
  model?: string;
}

/** 连接探测 / 连通性测试结果 */
export interface AgentConnectionProbeResult {
  ok: boolean;
  /** 网络往返耗时（毫秒） */
  latencyMs: number;
  /** 接口返回的 HTTP 状态码（如有） */
  httpStatus?: number;
  /** 面向用户的一句话结论 */
  message: string;
  /** 查询成功时返回的模型列表 */
  models?: AgentModelOption[];
  /** 模型是否确认可用；null 表示未验证 */
  modelVerified?: boolean | null;
}

/** 从本机 Claude 配置导入的结果 */
export interface AgentConnectionImportResult {
  connection: AgentConnection;
  /** 实际读取的配置文件路径 */
  source: string;
  warnings: string[];
  imported: {
    baseUrl: boolean;
    apiKey: boolean;
    models: number;
  };
}
