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
  Message,
  SessionOptions,
} from "../../shared/types";
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
  /** CLI 配置目录；用于会话历史定位（没有则用用户默认目录） */
  configDir?: string | null;
  /** 事件回调。provider 保证事件已归一、语义正确 */
  onEvent: (event: AgentEvent) => void;
  /** 首次拿到会话原始 id 时回调，供宿主持久化 */
  onSessionId: (rawId: string) => void;
  /** 子进程启动前回调精确的调用信息，供运行产物审计 */
  onInvocation?: (info: AgentInvocationInfo) => void;
}

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
   * 为一次运行准备 provider 专属环境。
   *
   * - 普通聊天：缺省即可，直接使用 CLI 本机配置；
   * - 工作流节点：provider 可按员工绑定的 MCP / Skill 生成临时投影。
   * 宿主只负责传入上下文并应用返回值，不感知具体 CLI。
   */
  prepareRun?(
    input: AgentRunInput,
  ): PreparedAgentRun | Promise<PreparedAgentRun>;

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
