/**
 * Agent 运行时契约（主进程侧）
 *
 * 与 shared/contracts/agent.ts 的分工：
 * - shared 侧只描述「宿主需要知道的元数据」（跨进程共享）
 * - 本文件描述「宿主如何驱动一个 Agent」，只在主进程内使用
 *
 * 设计要点：**provider 拥有自己的传输方式、流切分与事件解码**。
 * 宿主（agent-service / ipc）不感知行分隔协议、终端控制序列、命令拼接、
 * 会话文件路径等任何实现细节 —— 这些全部落在各自的 provider 包里。
 */

import type {
  AgentEvent,
  DigitalEmployee,
  InputImage,
  Message,
  Session,
  SessionOptions,
} from "../../shared/types";
import type {
  PermissionPromptDecision,
  PermissionPromptRequest,
} from "../../shared/permission-prompt";
import type {
  AgentManifest,
  AgentStatus,
  AgentUpgradeCheck,
  AgentUpgradeResult,
} from "../../shared/contracts/agent";

/**
 * 一次子进程调用的精确信息。
 *
 * provider 在真正启动进程前回调，宿主把它写入运行产物，
 * 用于排查“到底是哪个参数不对”。
 */
export interface AgentInvocationInfo {
  /** 实际可执行文件 / 命令 */
  command: string;
  /** 命令行参数（第 0 项通常也是 command；stdin 内容不在这里） */
  args: string[];
  cwd: string;
  /** 通过 stdin 传入的内容说明（不重复打印大段 prompt） */
  stdin?: string;
  /** 本次额外注入的环境变量（已脱敏由宿主负责） */
  env?: Record<string, string>;
  /** 本次移除的环境变量名 */
  envRemove?: string[];
  /** 无法体现在命令行中的说明 */
  notes?: string[];
}

/** 一次调用的输入 */
export interface RunOptions {
  prompt: string;
  /** 随本条消息一起发送的图片；不支持的 provider 可忽略 */
  images?: InputImage[];
  cwd: string;
  /**
   * 运行来源。
   * 工作流节点需要还原完整执行链路，因此保留命令类工具调用；
   * 聊天界面继续过滤这类噪声。缺省按 chat 处理。
   */
  mode?: "chat" | "workflow";
  /** 要恢复的会话引用；null 表示新建会话。引用语义由 provider 自己解释 */
  sessionRef: string | null;
  /** 宿主内部注入的运行参数（如工作流系统提示词）；不是用户可配置项 */
  opts?: SessionOptions;
  /** 单次运行超时（毫秒）。由宿主从设置读出后传入；缺省则用 provider 自己的默认值 */
  timeoutMs?: number;
  /**
   * 本次子进程追加的环境变量（与 process.env 合并）。
   * 工作流节点用它注入独立的 CLAUDE_CONFIG_DIR，普通会话不传。
   */
  env?: Record<string, string>;
  /**
   * 本次子进程需要剔除的环境变量。
   * 用于工作流节点：避免宿主进程里的接入变量覆盖节点自己的配置。
   */
  envRemove?: string[];
  /** provider 额外拼到命令行末尾的参数（例如 --mcp-config / --no-session-persistence） */
  extraArgs?: string[];
  /**
   * 本次运行的权限模式（settings 命名，如 `bypassPermissions`）。
   *
   * 由宿主从会话快照 / Agent 默认值解析后传入；provider 负责映射成自己的
   * 命令行开关（Claude 为 `--permission-mode`，`default` → `manual`）。
   * 缺省表示不覆盖，沿用 provider 的本机配置。
   */
  permissionMode?: string;
  /** CLI 配置目录；用于会话历史定位（没有则用用户默认目录） */
  configDir?: string | null;
  /** 事件回调。provider 保证事件已归一、语义正确 */
  onEvent: (event: AgentEvent) => void;
  /** 首次拿到会话原始 id 时回调，供宿主持久化 */
  onSessionId: (rawId: string) => void;
  /** 子进程启动前回调精确的调用信息，供运行产物审计 */
  onInvocation?: (info: AgentInvocationInfo) => void;
  /**
   * 本轮是否允许把工具授权询问交给宿主（只有带 UI 的聊天运行开启）。
   * provider 据此决定是否启用双向控制通道；无人值守运行保持 false。
   */
  allowPermissionPrompts?: boolean;
  /** provider 的带外控制消息（权限询问 / 取消）；不进入聊天事件流 */
  onControl?: (control: AgentControlMessage) => void;
}

/** provider 归一化后的控制通道消息 */
export type AgentControlMessage =
  | { type: "permission_request"; request: PermissionPromptRequest }
  | { type: "permission_cancel"; requestId: string };

/** Provider 的本机配置位置（只读展示，Nova 不修改） */
export interface AgentConfigLocation {
  configPath: string | null;
  configExists: boolean;
  configNote?: string;
}

/** 一次运行的准备上下文 */
export interface AgentRunInput {
  mode: "workflow" | "chat";
  sessionId: string;
  cwd: string;
  /**
   * 本次运行专用的可写临时目录（工作流节点使用）。
   *
   * Claude provider 已改用员工常驻运行时目录（与聊天共用），不再使用它；
   * 保留该字段供其它 provider 放临时配置投影，运行结束由宿主删除。
   */
  runtimeDir?: string;
  /** 工作流节点绑定的数字员工 */
  employee?: DigitalEmployee;
  /** 宿主内部注入的运行参数（如工作流系统提示词） */
  opts?: SessionOptions;
}

/** provider 为一次运行准备好的环境 */
export interface PreparedAgentRun {
  /** 本次运行使用的 CLI 配置目录；null / undefined 表示使用 CLI 默认目录 */
  configDir?: string | null;
  env?: Record<string, string>;
  envRemove?: string[];
  extraArgs?: string[];
  warnings?: string[];
  /** 本次实际注入的资产清单；供运行产物展示“加载了什么” */
  injected?: {
    mcpServers: string[];
    skills: string[];
  };
}

/**
 * 聊天运行时的宿主路径。
 *
 * 由宿主分配，provider 不得自行推导 —— 同一 Agent 的会话数据必须始终
 * 落在宿主指定的目录里，才能保证历史回放与 --resume 可定位。
 */
export interface ChatRuntimePaths {
  /** 会话运行时根目录（provider 可在此创建自己的 home 子目录） */
  root: string;
  /** 所有 home 共享的 CLI 会话数据目录 */
  projectsDir: string;
}

/** 一次聊天运行的环境准备输入 */
export interface ChatRuntimeInput {
  session: Session;
  /** 本轮回答者；null 表示通用助手（不绑定员工） */
  employee: DigitalEmployee | null;
  paths: ChatRuntimePaths;
  /**
   * send：发送前完整准备（含系统提示词 / 知识库）；
   * materialize：仅提前物化目录（切换员工时使用），可跳过知识库扫描。
   */
  purpose?: "send" | "materialize";
}

/** provider 为一次聊天运行准备好的环境 */
export interface PreparedChatRun extends PreparedAgentRun {
  /** 本轮使用的 CLI 配置目录；聊天运行时必须有确定的目录 */
  configDir: string;
  /** 本轮系统提示词（含员工人设 / 知识库） */
  systemPrompt?: string;
}

/** 一次运行的终态 */
export interface RunResult {
  exitCode: number;
  duration: number;
  /**
   * 非零退出时的诊断信息（stderr 尾部或启动错误）。
   * 语义由 provider 填写，宿主只用于展示与恢复策略判断。
   */
  error?: string;
}

/**
 * 一次运行的句柄。
 * provider 决定如何启动子进程、如何切分行、如何清洗控制序列 —— 全部封装在内部。
 */
export interface RunSession {
  /** 本次运行的终态 */
  readonly done: Promise<RunResult>;
  /** 是否已被中断 */
  readonly aborted: boolean;
  /** 请求中断（幂等） */
  abort(): void;
  /**
   * 把一行控制应答写回子进程 stdin（例如 control_response）。
   * 运行已结束 / 被中断时返回 false。不提供该能力的 provider 可省略。
   */
  respondControl?(line: string): boolean;
  /**
   * 回答一次工具授权询问（语义层，宿主只调这个）。
   * provider 负责编码成自己的控制协议；无法送达时返回 false。
   */
  respondPermission?(
    requestId: string,
    decision: PermissionPromptDecision,
  ): boolean;
}

/** 会话引用上下文：引用语义由 provider 解释，宿主只负责原样传回 */
export interface SessionContext {
  cwd: string;
  configDir?: string | null;
}

/**
 * 一次性文本生成的输入。
 *
 * 与 RunOptions 的区别：不创建会话、不落盘历史、不开工具，
 * 只把 prompt 交给模型并返回最终纯文本。
 */
export interface CompleteOptions {
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  /**
   * 增量输出回调。
   *
   * provider 支持流式输出时逐段回传，调用方可以据此展示进度；
   * 不支持时忽略即可，最终文本仍以 complete() 的返回值为准。
   */
  onChunk?: (chunk: string) => void;
  /**
   * 取消信号。
   *
   * abort 后 provider 应尽快终止子进程并 reject；调用方据 signal.aborted
   * 区分「用户取消」与「真正的失败」。
   */
  signal?: AbortSignal;
}

export interface AgentProvider {
  readonly manifest: AgentManifest;

  /** 检测本机是否安装 */
  detect(): Promise<AgentStatus>;

  /**
   * 检查是否有新版本。
   * 缺省表示该 Agent 不支持版本检测，UI 不展示升级入口。
   */
  checkUpgrade?(): Promise<AgentUpgradeCheck>;

  /**
   * 升级到最新版本；过程文本通过 onProgress 增量回调。
   * 缺省表示该 Agent 不支持由宿主升级。
   */
  upgrade?(onProgress?: (chunk: string) => void): Promise<AgentUpgradeResult>;

  /** 本机配置位置；缺省表示该 Agent 没有可展示的固定路径 */
  configInfo?(): AgentConfigLocation;

  /**
   * 本机运行配置摘要（模型 / 权限 / 接入地址等）。
   *
   * 只返回可展示、已脱敏的值，供运行产物记录“这次实际用的什么配置”。
   */
  describeRuntimeConfig?(): Record<string, string>;

  /**
   * 本机配置里的默认权限模式（settings 命名）。
   *
   * 新会话创建时用它做快照；工作流 / 自动化等没有工具栏的运行也用它兜底。
   * 缺省表示该 provider 没有权限档位概念。
   */
  defaultPermissionMode?(): string;

  /**
   * 为一次运行准备 provider 专属环境。
   *
   * - 普通聊天：缺省即可，直接使用 CLI 本机配置；
   * - 工作流节点：provider 可按员工绑定的 MCP / Skill 生成临时投影。
   * 宿主只负责传入上下文并应用返回值，不感知具体 CLI。
   */
  prepareRun?(
    input: AgentRunInput,
  ): PreparedAgentRun | Promise<PreparedAgentRun>;

  /**
   * 为一次聊天运行准备 provider 专属环境。
   *
   * 聊天与工作流的环境形态不同：聊天需要一份可持续复用的会话 home
   * （多员工切换时共享同一份 CLI 会话数据），工作流节点则是一次性投影。
   * 因此单独提供该能力，避免宿主直接感知 CLAUDE_CONFIG_DIR / mcp.json
   * 等具体 CLI 细节。
   *
   * 缺省表示该 Agent 不需要会话级运行时，宿主直接沿用 CLI 默认配置。
   */
  prepareChatRun?(
    input: ChatRuntimeInput,
  ): PreparedChatRun | Promise<PreparedChatRun>;

  /** 发起一次对话（新建或恢复由 opts.sessionRef 决定） */
  start(opts: RunOptions): RunSession;

  /**
   * 一次性文本生成：prompt → 纯文本。
   *
   * 用于提交信息、标题这类宿主内部的小任务：不创建会话、不落盘历史，
   * 也不应启用工具（避免模型顺手动仓库）。缺省表示该 Agent 不支持。
   */
  complete?(opts: CompleteOptions): Promise<string>;

  /**
   * 把首次运行拿到的原始会话 id 规范化为可长期复用的引用。
   * 例：Claude 直接返回会话 uuid；其他 CLI 可能返回会话文件路径。
   */
  normalizeSessionRef(rawId: string, ctx: SessionContext): string;

  /**
   * 历史版本号，供宿主判断缓存是否失效。
   * 返回 null 表示该 provider 无法廉价地判断会话是否变化，宿主将不做缓存。
   * 契约：版本号不变 ⟺ readHistory 的结果不变。
   */
  historyVersion(ref: string, ctx: SessionContext): Promise<string | null>;

  /** 回放历史为 UI 消息列表。失败返回空数组，不抛错 */
  readHistory(ref: string, ctx: SessionContext): Promise<Message[]>;

  /** 删除 CLI 侧会话数据。失败静默 */
  deleteSession(ref: string, ctx: SessionContext): Promise<void>;
}
