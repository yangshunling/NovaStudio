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

import type { AgentEvent, Message, SessionOptions } from "../../shared/types";
import type {
  AgentManifest,
  AgentModelOption,
  AgentStatus,
} from "../../shared/contracts/agent";

/** 一次调用的输入 */
export interface RunOptions {
  prompt: string;
  cwd: string;
  /** 要恢复的会话引用；null 表示新建会话。引用语义由 provider 自己解释 */
  sessionRef: string | null;
  /** 运行参数。键由本 provider 的 manifest.options 声明，值由宿主原样回传 */
  opts?: SessionOptions;
  /** 单次运行超时（毫秒）。由宿主从设置读出后传入；缺省则用 provider 自己的默认值 */
  timeoutMs?: number;
  /** 事件回调。provider 保证事件已归一、语义正确 */
  onEvent: (event: AgentEvent) => void;
  /** 首次拿到会话原始 id 时回调，供宿主持久化 */
  onSessionId: (rawId: string) => void;
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
}

export interface AgentProvider {
  readonly manifest: AgentManifest;

  /** 检测本机是否安装 */
  detect(): Promise<AgentStatus>;

  /**
   * 列出该 Agent 当前可选的模型。
   * 可选实现：不支持或获取失败时返回空数组，宿主会回退为手动输入。
   */
  listModels?(): Promise<AgentModelOption[]>;

  /** 发起一次对话（新建或恢复由 opts.sessionRef 决定） */
  start(opts: RunOptions): RunSession;

  /**
   * 把首次运行拿到的原始会话 id 规范化为可长期复用的引用。
   * 例：pi 需要把 uuid 升级为会话 JSONL 文件路径；opencode 直接返回原 id。
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
