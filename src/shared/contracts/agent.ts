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
}

/** manifest + status 的合并视图，UI 只消费这一个结构 */
export interface AgentInfo extends AgentManifest {
  status: AgentStatus;
}
