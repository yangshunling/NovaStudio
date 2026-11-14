/**
 * 行分隔输出的运行实现
 *
 * 适用于「stdout 按行输出文本、每行可独立解码」的 CLI（Claude Code 即属于这一类）。
 *
 * 重要：这是**可选复用**的基础设施，不是强制管线。
 * 如果某个 Agent 不是行分隔协议（例如 SSE、事件流、一次性输出整块 JSON、
 * 或需要双向交互的协议），请直接在自己的 provider 里实现 AgentProvider.start()，
 * 完全不必套用本文件 —— 这正是把 transport 与 decode 交回 provider 的意义。
 */

import type { AgentEvent } from "../../shared/types";
import type {
  AgentControlMessage,
  RunOptions,
  RunResult,
  RunSession,
} from "./types";
import {
  createLineBuffer,
  spawnChild,
  stripAnsi,
  type Transport,
  type TransportHandlers,
} from "./transport";
import { errorMessage } from "../../shared/error";

/** 默认超时：30 分钟（复杂任务需要较长时间；可在设置-通用里自定义） */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** 中断后等待 exit 回调的兜底时长：部分平台上 kill 可能不触发 exit */
const ABORT_FALLBACK_MS = 1500;

/**
 * 保留多少 stderr 尾部用于非零退出时的错误说明。
 * 只取尾部：CLI 的致命错误通常在最后几行，早期告警没有诊断价值。
 */
const STDERR_TAIL_LIMIT = 4000;

export interface LineRunConfig {
  /** 完整命令行，第 0 项为可执行文件，由 provider 自行拼装 */
  args: string[];
  /** 工作目录，调用方保证已存在 */
  cwd: string;
  /** 超时毫秒数 */
  timeoutMs?: number;
  /** 子进程追加的环境变量 */
  env?: Record<string, string>;
  /** 子进程需要剔除的环境变量 */
  envRemove?: string[];
  /** 通过 stdin 传给子进程的内容（含换行的 prompt 不能走命令行参数） */
  stdin?: string;
  /**
   * 保持 stdin 打开，等 result 行或进程结束再关闭。
   *
   * 双向控制通道（stream-json 输入 + 权限询问）必须打开：应答要写回
   * 同一根 stdin。缺省 false，保持「写完即关」。
   */
  keepStdinOpen?: boolean;
  /** 控制通道消息（权限询问 / 取消）；不是聊天事件，由上层处理 */
  onControlMessage?: (control: AgentControlMessage) => void;
  /** 从一行输出中提取会话 id；返回 null 表示该行不含会话信息 */
  extractSessionId(line: string): string | null;
  /** 把一行输出解码为事件（可返回多个） */
  decode(line: string): AgentEvent | AgentEvent[] | null;
  /**
   * 一次解析同时给出会话 id 与事件（避免每行 JSON.parse 两次）。
   * provider 提供时优先走它，extractSessionId / decode 只作兜底。
   */
  decodeLine?(line: string): {
    sessionId: string | null;
    event: AgentEvent | AgentEvent[] | null;
    /** 控制通道消息：不进入事件流 */
    control?: AgentControlMessage;
    /** result 行：本轮输入已处理完，可以关闭 stdin */
    closeInput?: boolean;
  } | null;
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

  /** stderr 尾部：只用于非零退出时的诊断，不进入协议解析 */
  let stderrTail = "";
  /** 本次运行是否已经发过 error 事件，避免 result 错误与退出码错误重复上报 */
  let sawErrorEvent = false;

  let resolveDone!: (result: RunResult) => void;
  const done = new Promise<RunResult>((resolve) => {
    resolveDone = resolve;
  });

  const emit = (event: AgentEvent): void => {
    if (event.type === "error") sawErrorEvent = true;
    handlers.onEvent(event);
  };

  const finish = (exitCode: number, message?: string) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);

    // 用户中断是主动行为，不带错误信息；超时/失败才需要诊断
    const diagnostic =
      exitCode !== 0 && !aborted
        ? message?.trim() || `Agent 进程退出码 ${exitCode}`
        : undefined;

    /*
     * 非零退出且调用方还没有看到具体错误时，补一条。
     * 解码层可能已经从 CLI 的 result 行拿到更准确的错误（如 resume 失效），
     * 此时不重复上报，但仍把诊断信息放进 RunResult，供宿主的恢复策略使用。
     */
    if (diagnostic && !muted && !sawErrorEvent) {
      emit({ type: "error", message: diagnostic, fatal: true });
    }
    resolveDone({
      exitCode,
      duration: Date.now() - startedAt,
      ...(diagnostic ? { error: diagnostic } : {}),
    });
  };

  timer = setTimeout(() => {
    if (settled) return;
    const message = `Agent timed out after ${Math.round(timeoutMs / 60000)} min`;
    // 超时原因必须在 muted 置位之前发出：finish 在 muted 时会抑制 error
    emit({ type: "error", message, fatal: true });
    // 超时属于失败，不算用户中断 —— 否则调用方会一直停在"执行中"
    muted = true;
    transport?.kill();
    finish(-1, message);
  }, timeoutMs);

  /** stdin 只能关一次；「result 到达」与「写完即关」两条路径都可能调用 */
  let inputEnded = false;
  const endInput = () => {
    if (inputEnded) return;
    inputEnded = true;
    transport?.endInput();
  };

  /** 单行 → 会话 id + 事件 */
  const handleLine = (raw: string) => {
    const line = raw.trim();
    if (!line) return;

    // 合并解析：一次 JSON.parse 同时拿到 session_id 与事件，省掉一半解析开销
    if (config.decodeLine) {
      const out = config.decodeLine(line);
      if (!out) return;
      if (out.sessionId) handlers.onSessionId(out.sessionId);
      // 控制帧不进入对话事件：权限询问要由上层回答
      if (out.control !== undefined) {
        config.onControlMessage?.(out.control);
        return;
      }
      // result 到达：本轮输入结束，关闭 stdin 让 -p 进程正常退出
      if (out.closeInput) endInput();
      if (!out.event) return;
      for (const event of Array.isArray(out.event) ? out.event : [out.event]) {
        emit(event);
      }
      return;
    }

    const sid = config.extractSessionId(line);
    if (sid) handlers.onSessionId(sid);
    const decoded = config.decode(line);
    if (!decoded) return;
    for (const event of Array.isArray(decoded) ? decoded : [decoded]) {
      emit(event);
    }
  };

  const transportHandlers: TransportHandlers = {
    onData: (chunk) => {
      // settled 之后到达的数据属于迟到输出，不能再进消息流
      if (muted || settled) return;
      for (const line of lines.push(stripAnsi(chunk))) handleLine(line);
    },
    onStderr: (chunk) => {
      stderrTail = (stderrTail + stripAnsi(chunk)).slice(-STDERR_TAIL_LIMIT);
    },
    onExit: (exitCode) => {
      // 处理尾部残片（最后一行可能没有换行符）
      if (!muted && !settled) handleLine(lines.take());
      finish(exitCode, exitCode !== 0 ? stderrTail.trim() || undefined : undefined);
    },
  };

  try {
    transport = spawnChild(
      config.args,
      config.cwd,
      config.env,
      config.envRemove,
      transportHandlers,
    );

    if (transport && config.stdin !== undefined) {
      // 双向控制通道要留着 stdin；其余场景写完就关，让 CLI 知道输入结束
      if (config.keepStdinOpen) transport.write(config.stdin);
      else transport.writeInput(config.stdin);
    }
  } catch (err) {
    const message = errorMessage(err);
    // 启动失败属于失败（不是用户中断），只是不需要再补一条重复的 error
    const diagnostic = `启动失败：${message}`;
    muted = true;
    emit({ type: "error", message: diagnostic, fatal: true });
    finish(-1, diagnostic);
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
    /**
     * 向子进程 stdin 追加一行（例如 control_response）。
     *
     * 运行已结束 / 被中断时返回 false，避免往已关闭的管道里写。
     */
    respondControl(line: string): boolean {
      if (settled || muted || !transport) return false;
      try {
        transport.write(line.endsWith("\n") ? line : `${line}\n`);
        return true;
      } catch {
        return false;
      }
    },
  };
}
