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
import type { AgentManifest, AgentStatus } from "../../shared/contracts/agent";

/** 一次调用的输入 */
export interface RunOptions {
  prompt: string;
  cwd: string;
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
   * provider 可以在这里放临时 mcp.json / 配置投影；运行结束由宿主删除。
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
}

/** 一次运行的终态 */
export interface RunResult {
  exitCode: number;
  duration: number;
}

/**
 * 一次运行的句柄。
 * provider 决定用 pty 还是 pipe、如何切分行、如何清洗终端控制序列 —— 全部封装在内部。
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

export interface AgentProvider {
  readonly manifest: AgentManifest;

  /** 检测本机是否安装 */
  detect(): Promise<AgentStatus>;

  /** 本机配置位置；缺省表示该 Agent 没有可展示的固定路径 */
  configInfo?(): AgentConfigLocation;

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
   * 把首次运行拿到的原始会话 id 规范化为可长期复用的引用。
   * 例：Claude 直接返回会话 uuid；其他 CLI 可能返回会话文件路径。
   */
  normalizeSessionRef(rawId: string, ctx: SessionContext): string;

  /**
   * 历史版本号，供宿主判断缓存是否失效。
   * 返回 null 表示该 provider 无法廉价地判断会话是否变化，宿主将不做缓存。
   * 契约：版本号不变 ⟺ readHistory 的结果不变。
   */
  historyVersion(ref: string, ctx: SessionContext): string | null;

  /** 回放历史为 UI 消息列表。失败返回空数组，不抛错 */
  readHistory(ref: string, ctx: SessionContext): Message[];

  /** 删除 CLI 侧会话数据。失败静默 */
  deleteSession(ref: string, ctx: SessionContext): void;
}
