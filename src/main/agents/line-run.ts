/**
 * 行分隔输出的运行实现
 *
 * 适用于「stdout 按行输出文本、每行可独立解码」的 CLI（pi / opencode 都属于这一类）。
 *
 * 重要：这是**可选复用**的基础设施，不是强制管线。
 * 如果某个 Agent 不是行分隔协议（例如 SSE、事件流、一次性输出整块 JSON、
 * 或需要双向交互的协议），请直接在自己的 provider 里实现 AgentProvider.start()，
 * 完全不必套用本文件 —— 这正是把 transport 与 decode 交回 provider 的意义。
 */

import type { AgentEvent } from "../../shared/types";
import type { RunOptions, RunResult, RunSession } from "./types";
import {
  createLineBuffer,
  spawnChild,
  spawnPty,
  stripAnsi,
  type Transport,
  type TransportHandlers,
} from "./transport";

/** 默认超时：30 分钟（复杂任务需要较长时间；可在设置-通用里自定义） */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** 中断后等待 exit 回调的兜底时长：部分平台上 kill 可能不触发 exit */
const ABORT_FALLBACK_MS = 1500;

export interface LineRunConfig {
  /** 完整命令行，第 0 项为可执行文件，由 provider 自行拼装 */
  args: string[];
  /** 工作目录，调用方保证已存在 */
  cwd: string;
  /** 传输方式，由 provider 选择 */
  transport: "pty" | "pipe";
  /** 超时毫秒数 */
  timeoutMs?: number;
  /** 从一行输出中提取会话 id；返回 null 表示该行不含会话信息 */
  extractSessionId(line: string): string | null;
  /** 把一行输出解码为事件（可返回多个） */
  decode(line: string): AgentEvent | AgentEvent[] | null;
}

/**
 * 启动一次行分隔运行。
 * 负责：进程生命周期、行切分、控制序列清洗、超时、中断。
 * 不负责：参数怎么拼、每行怎么解码 —— 那是 provider 的事。
 */
export function startLineRun(
  config: LineRunConfig,
  handlers: Pick<RunOptions, "onEvent" | "onSessionId">,
): RunSession {
  const startedAt = Date.now();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lines = createLineBuffer();

  // 两种"提前结束"必须区分开：
  // - aborted：用户主动中断（宿主不应记为失败）
  // - muted：已中断 / 已超时 / 启动失败，仅用于抑制后续输出与重复事件
  // 如果把超时、启动失败也当成 aborted，调用方会把失败误判为用户中断。
  let aborted = false;
  let muted = false;
  let settled = false;
  let transport: Transport | null = null;
  let timer: NodeJS.Timeout | null = null;

  let resolveDone!: (result: RunResult) => void;
  const done = new Promise<RunResult>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (exitCode: number, message?: string) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    // 非零退出且未被打断：补一条错误事件
    // （用户中断是主动行为，不应报错；超时原因已在触发处单独发出）
    if (exitCode !== 0 && !muted && message) {
      handlers.onEvent({ type: "error", message });
    }
    resolveDone({ exitCode, duration: Date.now() - startedAt });
  };

  timer = setTimeout(() => {
    if (settled) return;
    // 超时原因必须在 muted 置位之前发出：finish 在 muted 时会抑制 error
    handlers.onEvent({
      type: "error",
      message: `Agent timed out after ${Math.round(timeoutMs / 60000)} min`,
    });
    // 超时属于失败，不算用户中断 —— 否则调用方会一直停在"执行中"
    muted = true;
    transport?.kill();
    finish(-1);
  }, timeoutMs);

  /** 单行 → 会话 id + 事件 */
  const handleLine = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    const sid = config.extractSessionId(line);
    if (sid) handlers.onSessionId(sid);
    const decoded = config.decode(line);
    if (!decoded) return;
    for (const event of Array.isArray(decoded) ? decoded : [decoded]) {
      handlers.onEvent(event);
    }
  };

  const transportHandlers: TransportHandlers = {
    onData: (chunk) => {
      if (muted) return;
      for (const line of lines.push(stripAnsi(chunk))) handleLine(line);
    },
    onExit: (exitCode) => {
      // 处理尾部残片（最后一行可能没有换行符）
      if (!muted) handleLine(lines.take());
      finish(exitCode);
    },
  };

  try {
    transport =
      config.transport === "pty"
        ? spawnPty(config.args, config.cwd, transportHandlers)
        : spawnChild(config.args, config.cwd, transportHandlers);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 启动失败属于失败（不是用户中断），只是不需要再补一条重复的 error
    muted = true;
    handlers.onEvent({ type: "error", message: `启动失败：${message}` });
    finish(-1);
  }

  return {
    done,
    get aborted() {
      return aborted;
    },
    abort() {
      if (settled) return;
      aborted = true;
      muted = true;
      transport?.kill();
      // 兜底：部分平台上 kill 后收不到 exit 回调，避免 done 永久挂起
      setTimeout(() => finish(-1), ABORT_FALLBACK_MS);
    },
  };
}
