/**
 * Agent 服务 —— 会话与运行的唯一编排入口
 *
 * 把原先集中在一个大文件里的三类逻辑收拢到一处：
 * 1. 运行编排：启动 provider → 转发事件 → 规范化会话引用 → 落库
 * 2. 历史回放：带 LRU 缓存，缓存键与失效判断完全交给 provider
 * 3. 会话侧数据释放：删会话 / 删项目 / 重试任务共用同一套逻辑
 *
 * 本模块不感知 Electron 与 IPC —— 事件通过构造时注入的 emit 送出，
 * 因此可以脱离窗口独立测试。
 */

import { existsSync } from "fs";
import { randomUUID } from "crypto";
import type { AgentEvent, Message, Session, SessionOptions } from "../../shared/types";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { appendEvent } from "../../shared/agent-events";
import type { AgentInfo } from "../../shared/contracts/agent";
import type { IpcPushChannel, IpcPushMap } from "../../shared/contracts/ipc";
import { getProvider, listProviders } from "../agents/registry";
import { isResumeFailure } from "../agents/resume-error";
import type { AgentInvocationInfo, RunSession } from "../agents/types";
import * as db from "../db/sqlite";
import { errorMessage } from "../../shared/error";

/** 事件发射器，由 IPC 层注入（负责批量聚合与窗口推送） */
export type Emit = <C extends IpcPushChannel>(channel: C, payload: IpcPushMap[C]) => void;

/** 历史缓存容量上限（超出后淘汰最久未使用的条目） */
const HISTORY_CACHE_LIMIT = 32;

/** 退出时等待运行收尾的上限：超时后仍然退出，避免应用关不掉 */
const SHUTDOWN_TIMEOUT_MS = 5000;

/** 单次运行超时（毫秒）：来自设置里的分钟数，非法值回退默认 */
function resolveTimeoutMs(): number {
  const raw = db.getSetting("agentTimeoutMinutes");
  const minutes = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return DEFAULT_SETTINGS.agentTimeoutMinutes * 60_000;
  }
  // 向下取整会把 0.5 分钟变成 0ms（立即超时）；这里至少保留 1 分钟
  return Math.max(1, Math.round(minutes)) * 60_000;
}

export interface RunParams {
  sessionId: string;
  prompt: string;
  cwd: string;
  opts?: SessionOptions;
  /** 子进程追加环境变量（工作流节点的独立配置目录等） */
  env?: Record<string, string>;
  /** 子进程需要剔除的环境变量（避免宿主环境污染隔离配置） */
  envRemove?: string[];
  /** provider 额外命令行参数（工作流节点的 MCP / 会话持久化等） */
  extraArgs?: string[];
  /** 宿主侧旁路监听：除推送到渲染层外，引擎也需要实时拿到事件 */
  onEvent?: (event: AgentEvent) => void;
  /**
   * 用户消息落库后回调消息 id。
   * 工作流用它把「本轮起点」立即写进调用记录，运行中查看详情时才能正确切分轮次。
   */
  onUserMessage?: (messageId: string) => void;
  /** 子进程启动前拿到精确调用信息（运行产物审计用） */
  onInvocation?: (info: AgentInvocationInfo) => void;
}

export interface RunOutcome {
  ok: boolean;
  exitCode: number;
  duration: number;
  /** 被用户中断：不记为完成，也不推送 done */
  aborted: boolean;
  error?: string;
  /** 本轮落库的用户消息 id；会话不存在等早期失败时为空 */
  userMessageId?: string;
  /** 本轮落库的 assistant 消息 id；没有可保存内容时为空 */
  assistantMessageId?: string;
  /**
   * 本轮最终正文（来自权威 message_end 块）。
   * 工作流用它把产物精确归属到当前轮，避免多轮共用会话时拿到上一轮结果。
   */
  assistantText?: string;
  /**
   * 本轮的 --resume 失效（CLI 找不到旧会话）。
   * 工作流修改轮据此明确失败，而不是把「没接上上下文」当成一次成功修改。
   */
  resumeFailed?: boolean;
}

export interface AgentService {
  /** 全部 Agent 的 manifest + 运行时检测结果 + 本机配置位置 */
  listAgentInfos(): Promise<AgentInfo[]>;
  /** 解析工作目录：取第一个存在的候选，否则回退主进程目录 */
  resolveCwd(...candidates: (string | undefined | null)[]): string;
  /** 执行一次对话（新建或恢复由会话已存的引用 + provider 能力决定） */
  run(params: RunParams): Promise<RunOutcome>;
  /** 中断指定会话；返回是否确实有运行中的会话 */
  abort(sessionId: string): boolean;
  /** 指定会话是否仍有运行中的 Agent 进程（含尚未完成落库的收尾阶段） */
  isRunning(sessionId: string): boolean;
  /** 取会话元数据 + 回放历史 */
  getSessionWithHistory(sessionId: string): Promise<Session | null>;
  /**
   * 中断该会话、等待运行收尾，再清理其 CLI 侧数据与缓存。
   * 必须先等运行结束再删数据库行，否则运行收尾写入 messages 会触发外键错误。
   */
  releaseSession(sessionId: string): Promise<void>;
  /** 中断并清理某项目下所有会话的 CLI 侧数据与缓存 */
  releaseProject(projectId: string): Promise<void>;
  /**
   * 应用退出：中断全部运行中的会话，并等待它们完成落库收尾。
   * 必须在关库之前 await，否则最后一条 assistant 消息可能写不进去。
   */
  shutdown(): Promise<void>;
}

/**
 * 取事件流里最后一段非空正文。
 *
 * message_end 已在 appendEvent 里收敛成普通 text 块，因此这里直接倒序找 text。
 * 工作流多轮共用同一个会话时，返回值只代表「本轮」的最终正文。
 */
function lastAssistantText(content: AgentEvent[]): string {
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const event = content[i];
    if (event.type !== "text") continue;
    const text = event.content.trim();
    if (text) return text;
  }
  return "";
}

export function createAgentService(emit: Emit): AgentService {
  /** 并发运行表：sessionId → 运行句柄。仅在 run() 的 finally 中移除 */
  const running = new Map<string, RunSession>();

  /** 历史缓存：provider + 配置目录 + 会话引用 → { 版本, 消息 } */
  const historyCache = new Map<string, { version: string; messages: Message[] }>();

  /** 缓存键必须区分 configDir：同一引用在隔离配置目录下指向不同文件 */
  function historyKey(session: Session): string | null {
    if (!session.agentSessionId) return null;
    return `${session.agentId}\u0000${session.configDir ?? ""}\u0000${session.agentSessionId}`;
  }

  /**
   * 带缓存的历史回放。
   * 先问版本号（廉价），命中即返回；未命中才真正读取，再按 provider 给的版本号入缓存。
   */
  async function readHistoryCached(session: Session): Promise<Message[]> {
    const provider = getProvider(session.agentId);
    const ref = session.agentSessionId;
    if (!provider || !ref) return [];

    const key = historyKey(session);
    if (!key) return [];

    const ctx = { cwd: session.cwd, configDir: session.configDir ?? null };
    const version = await provider.historyVersion(ref, ctx);

    if (version !== null) {
      const cached = historyCache.get(key);
      if (cached && cached.version === version) {
        // LRU：命中后重新插入，使其成为"最近使用"
        historyCache.delete(key);
        historyCache.set(key, cached);
        return cached.messages;
      }
    }

    const messages = await provider.readHistory(ref, ctx);

    if (version !== null) {
      historyCache.set(key, { version, messages });
      while (historyCache.size > HISTORY_CACHE_LIMIT) {
        const oldest = historyCache.keys().next().value;
        if (oldest === undefined) break;
        historyCache.delete(oldest);
      }
    }
    return messages;
  }

  /**
   * 给本地已落库的旧消息补齐 diff 行号。
   *
   * lineStarts 是后加的字段：在此之前落库的 tool_call 没有行号，而历史展示
   * 优先读数据库，于是老会话的 diff 永远拿不到行号。provider 回放能算出这些
   * 行号（Claude 会话文件里有 originalFile / structuredPatch），这里按 callId
   * 合并回去 —— 只补缺失，不覆盖已有值。
   *
   * 没有「写文件类调用缺行号」时直接返回，避免为每一次打开会话都回放。
   */
  async function backfillLineStarts(session: Session, messages: Message[]): Promise<Message[]> {
    const missing = messages.some((message) =>
      message.content.some(
        (event) => event.type === "tool_call" && event.kind === "write" && !event.lineStarts,
      ),
    );
    if (!missing) return messages;

    const replayed = await readHistoryCached(session);
    if (replayed.length === 0) return messages;

    const byCall = new Map<string, number[]>();
    for (const message of replayed) {
      for (const event of message.content) {
        if (event.type === "tool_call" && event.callId && event.lineStarts) {
          byCall.set(event.callId, event.lineStarts);
        }
      }
    }
    if (byCall.size === 0) return messages;

    for (const message of messages) {
      for (const event of message.content) {
        if (event.type !== "tool_call" || event.lineStarts || !event.callId) continue;
        const starts = byCall.get(event.callId);
        if (starts) event.lineStarts = starts;
      }
    }
    return messages;
  }

  /** 释放单个会话的 CLI 侧数据；是否清理由 provider 的能力声明决定 */
  async function dropSessionArtifacts(sessionId: string): Promise<void> {
    const session = db.getSession(sessionId);
    if (!session) return;
    const ref = session.agentSessionId;
    if (!ref) return;

    const provider = getProvider(session.agentId);
    if (provider?.manifest.capabilities.sessionCleanup) {
      await provider.deleteSession(ref, {
        cwd: session.cwd,
        configDir: session.configDir ?? null,
      });
    }
    const key = historyKey(session);
    if (key) historyCache.delete(key);
  }

  /**
   * 等待某个会话的运行完全收尾（含消息落库）。
   *
   * run() 在写库完成后才从 running 表移除记录，因此这里是可靠的同步点。
   * 超时后仍继续清理：极端情况下宁可清理失败，也不能让删除操作永远挂起。
   */
  async function waitForIdle(sessionId: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (running.has(sessionId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (running.has(sessionId)) {
      console.warn(`[agent] 会话 ${sessionId} 未在 ${timeoutMs}ms 内结束，继续清理`);
    }
  }

  return {
    async listAgentInfos(): Promise<AgentInfo[]> {
      const providers = listProviders();
      const statuses = await Promise.all(
        providers.map((p) => p.detect().catch(() => ({ installed: false }))),
      );
      return providers.map((p, i) => {
        const config = p.configInfo?.() ?? {
          configPath: null,
          configExists: false,
        };
        return {
          ...p.manifest,
          status: statuses[i],
          ...config,
        };
      });
    },

    resolveCwd(...candidates) {
      const raw = candidates.find((c) => c);
      if (raw && existsSync(raw)) return raw;
      return process.cwd();
    },

    async run(params: RunParams): Promise<RunOutcome> {
      const {
        sessionId,
        prompt,
        cwd,
        opts,
        env,
        envRemove,
        extraArgs,
        onEvent,
        onInvocation,
      } = params;
      const failed = (error: string): RunOutcome => ({
        ok: false,
        exitCode: -1,
        duration: 0,
        aborted: false,
        error,
      });

      const session = db.getSession(sessionId);
      if (!session) return failed(`会话不存在: ${sessionId}`);

      // 同一会话只允许一个运行：running 表按 sessionId 存放句柄，
      // 并发进入会互相覆盖，中断 / 状态判断都会错乱。
      if (running.has(sessionId)) {
        return failed("会话正在运行，请等待本次执行结束");
      }

      const provider = getProvider(session.agentId);
      if (!provider) return failed(`未知 Agent: ${session.agentId}`);

      // 能力驱动：不支持多轮的 provider 永远按新会话发起
      const canResume =
        provider.manifest.capabilities.resume && !!session.agentSessionId;
      const sessionRef = canResume ? session.agentSessionId : null;

      // 用对象持有闭包内的赋值，避免被控制流分析误判为恒 null
      const captured: { rawId: string | null } = { rawId: null };

      /*
       * 升级兼容：旧会话的历史只存在于 CLI 侧，本地 messages 表是空的。
       * 如果直接开始写新消息，后续 getSessionWithHistory 只会返回新消息，
       * 旧对话在界面上会“消失”。因此在第一次运行前把 CLI 历史导入本地。
       */
      if (
        !db.hasSessionMessages(sessionId) &&
        !db.isSessionHistoryComplete(sessionId) &&
        session.agentSessionId
      ) {
        const history = await readHistoryCached(session);
        if (history.length > 0) db.importSessionMessages(sessionId, history);
      }

      // 持久化用户消息：在运行前落库，确保即使运行失败也能看到原始指令
      const userMsg: Message = {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", content: prompt }],
        timestamp: Date.now(),
      };
      db.saveSessionMessage(sessionId, userMsg);
      const userMessageId = userMsg.id;
      params.onUserMessage?.(userMessageId);

      // 累积 assistant 消息的事件流（镜像渲染进程的 appendEvent 逻辑）
      let assistantContent: AgentEvent[] = [];

      let runSession: RunSession;
      try {
        runSession = provider.start({
          prompt,
          cwd,
          mode: session.source === "workflow" ? "workflow" : "chat",
          sessionRef,
          opts,
          env,
          envRemove,
          extraArgs,
          configDir: session.configDir ?? null,
          timeoutMs: resolveTimeoutMs(),
          onEvent: (event) => {
            // done 事件仅复位流式状态，不进入消息内容（与渲染进程 _onEvent 一致）
            if (event.type !== "done") {
              assistantContent = appendEvent(assistantContent, event);
            }
            // 工作流会话不出现在聊天界面，事件只交给引擎；
            // 否则渲染层的 messagesBySession 会持续堆积永远不会展示的数据。
            if (session.source !== "workflow") {
              emit("agent:event", { sessionId, event });
            }
            onEvent?.(event);
          },
          onSessionId: (rawId) => {
            captured.rawId = rawId;
          },
          onInvocation,
        });
      } catch (err) {
        // provider 在拉起进程前失败（临时文件、配置投影等）
        return {
          ...failed(errorMessage(err)),
          userMessageId,
        };
      }
      running.set(sessionId, runSession);

      try {
        const result = await runSession.done;

        /*
         * 恢复失败自愈：--resume 指向的 CLI 会话已经不存在（文件被删、
         * cwd 变化、版本不兼容）。不能继续沿用旧引用，否则后续每次发送
         * 都会重复失败。清掉引用并告知用户，下一轮自动开启新上下文。
         *
         * 诊断文本有两个来源：line-run 收集的 stderr 尾部，以及解码层
         * 从 CLI result 行提取的错误事件。两者任一包含失效文案都要自愈，
         * 避免某些版本只把错误写进 stdout。
         */
        const errorMessages = assistantContent
          .filter(
            (event): event is Extract<AgentEvent, { type: "error" }> =>
              event.type === "error",
          )
          .map((event) => event.message);
        const failureText = [result.error, ...errorMessages]
          .filter(Boolean)
          .join("\n");

        const resumeFailed =
          Boolean(sessionRef) &&
          !runSession.aborted &&
          isResumeFailure(failureText);
        if (resumeFailed) {
          const previousKey = historyKey(session);
          if (previousKey) historyCache.delete(previousKey);
          db.clearAgentSessionId(sessionId);

          const warning: AgentEvent = {
            type: "warning",
            message:
              "上一次的会话上下文已失效（CLI 找不到该会话），已清除旧引用。下一次发送会开启新的上下文。",
          };
          assistantContent = appendEvent(assistantContent, warning);
          // 工作流会话只在引擎内部使用，不往聊天界面推
          if (session.source !== "workflow") {
            emit("agent:event", { sessionId, event: warning });
          }
          onEvent?.(warning);
        }

        // 持久化 assistant 消息：无论成功/失败/中断，已累积的事件流都落库
        let assistantMessageId: string | null = null;
        if (assistantContent.length > 0) {
          assistantMessageId = randomUUID();
          db.saveSessionMessage(sessionId, {
            id: assistantMessageId,
            role: "assistant",
            content: assistantContent,
            timestamp: Date.now(),
          });
        }

        // 会话引用规范化 + 落库：语义由 provider 决定，宿主只负责存取。
        // 只要本轮已经拿到 CLI 侧的会话 id，就必须落库 —— 即便本轮被中断/超时，
        // CLI 侧会话依然存在且可恢复。否则用户随后在同一会话里追问时会话引用缺失，
        // Agent 会"失忆"（自动化任务被停止/超时后追问，就是这种表现）。
        // resume 失败时 CLI 回报的仍是那个失效的旧 id，不要把它写回数据库
        if (!resumeFailed && captured.rawId) {
          const ref = provider.normalizeSessionRef(captured.rawId, { cwd });
          if (ref !== session.agentSessionId) {
            const previousKey = historyKey(session);
            if (previousKey) historyCache.delete(previousKey);
            db.updateAgentSessionId(sessionId, ref);
          }
        }

        return {
          ok: true,
          exitCode: result.exitCode,
          duration: result.duration,
          aborted: runSession.aborted,
          userMessageId,
          assistantMessageId: assistantMessageId ?? undefined,
          assistantText: lastAssistantText(assistantContent),
          resumeFailed,
        };
      } finally {
        try {
          // 本地消息已经覆盖本次运行；之后再打开会话无需再向 CLI 补历史
          db.markSessionHistoryComplete(sessionId);
        } catch {
          // 应用退出时数据库可能已关闭：不能因此丢失 running 表的清理
        }
        running.delete(sessionId);
      }
    },

    isRunning(sessionId: string): boolean {
      return running.has(sessionId);
    },

    abort(sessionId: string): boolean {
      const runSession = running.get(sessionId);
      if (!runSession) return false;
      // 不在此处移除表项：由 run() 的 finally 统一清理，
      // 这样 run() 才能读到 runSession.aborted 来判断是否被中断
      runSession.abort();
      return true;
    },

    async getSessionWithHistory(sessionId: string): Promise<Session | null> {
      const session = db.getSession(sessionId);
      if (!session) return null;

      // 优先从数据库读取持久化的完整事件流（含工具调用、思考等）。
      // 新会话在 run() 里已落库；老会话（升级前创建的）无 DB 数据，
      // 回退到 provider 从 CLI 侧回放（仅文本，不含工具调用细节）。
      const persisted = db.readSessionMessages(sessionId);
      if (persisted) {
        return { ...session, messages: await backfillLineStarts(session, persisted) };
      }
      return { ...session, messages: await readHistoryCached(session) };
    },

    async releaseSession(sessionId: string): Promise<void> {
      running.get(sessionId)?.abort();
      await waitForIdle(sessionId);
      await dropSessionArtifacts(sessionId);
    },

    async releaseProject(projectId: string): Promise<void> {
      const sessionIds = db.listSessionIdsByProject(projectId);
      for (const sessionId of sessionIds) running.get(sessionId)?.abort();
      await Promise.all(sessionIds.map((sessionId) => waitForIdle(sessionId)));
      await Promise.all(sessionIds.map((sessionId) => dropSessionArtifacts(sessionId)));
    },

    async shutdown(): Promise<void> {
      for (const runSession of running.values()) runSession.abort();

      /*
       * 不能只等 RunSession.done：run() 在 done 之后还要写 messages /
       * 更新会话引用，真正完成收尾才会从 running 表移除。这里以 running
       * 变空为准，并设置上限，避免异常进程让应用永远退不掉。
       */
      const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
      while (running.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (running.size > 0) {
        console.warn(
          `[agent] 退出时仍有 ${running.size} 个会话未在 ${SHUTDOWN_TIMEOUT_MS}ms 内收尾，继续退出`,
        );
      }
    },
  };
}
