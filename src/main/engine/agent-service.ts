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
import { appendEvent } from "../../shared/merge";
import type { AgentInfo } from "../../shared/contracts/agent";
import type { IpcPushChannel, IpcPushMap } from "../../shared/contracts/ipc";
import { getProvider, listProviders } from "../agents/registry";
import type { RunSession } from "../agents/types";
import * as db from "../db/sqlite";

/** 事件发射器，由 IPC 层注入（负责批量聚合与窗口推送） */
export type Emit = <C extends IpcPushChannel>(channel: C, payload: IpcPushMap[C]) => void;

/** 历史缓存容量上限（超出后淘汰最久未使用的条目） */
const HISTORY_CACHE_LIMIT = 32;

/** 单次运行超时（毫秒）：来自设置里的分钟数，非法值回退默认 */
function resolveTimeoutMs(): number {
  const raw = db.getSetting("agentTimeoutMinutes");
  const minutes = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return DEFAULT_SETTINGS.agentTimeoutMinutes * 60_000;
  }
  return Math.floor(minutes) * 60_000;
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
}

export interface RunOutcome {
  ok: boolean;
  exitCode: number;
  duration: number;
  /** 被用户中断：不记为完成，也不推送 done */
  aborted: boolean;
  error?: string;
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
  /** 取会话元数据 + 回放历史 */
  getSessionWithHistory(sessionId: string): Session | null;
  /** 中断该会话并清理其 CLI 侧数据与缓存 */
  releaseSession(sessionId: string): void;
  /** 清理某项目下所有会话的 CLI 侧数据与缓存 */
  releaseProject(projectId: string): void;
}

export function createAgentService(emit: Emit): AgentService {
  /** 并发运行表：sessionId → 运行句柄。仅在 run() 的 finally 中移除 */
  const running = new Map<string, RunSession>();

  /** 历史缓存：会话引用 → { 版本, 消息 }。仅当 provider 提供版本号时才写入 */
  const historyCache = new Map<string, { version: string; messages: Message[] }>();

  /**
   * 带缓存的历史回放。
   * 先问版本号（廉价），命中即返回；未命中才真正读取，再按 provider 给的版本号入缓存。
   */
  function readHistoryCached(session: Session): Message[] {
    const provider = getProvider(session.agentId);
    const ref = session.agentSessionId;
    if (!provider || !ref) return [];

    const ctx = { cwd: session.cwd, configDir: session.configDir ?? null };
    const version = provider.historyVersion(ref, ctx);

    if (version !== null) {
      const cached = historyCache.get(ref);
      if (cached && cached.version === version) {
        // LRU：命中后重新插入，使其成为"最近使用"
        historyCache.delete(ref);
        historyCache.set(ref, cached);
        return cached.messages;
      }
    }

    const messages = provider.readHistory(ref, ctx);

    if (version !== null) {
      historyCache.set(ref, { version, messages });
      while (historyCache.size > HISTORY_CACHE_LIMIT) {
        const oldest = historyCache.keys().next().value;
        if (oldest === undefined) break;
        historyCache.delete(oldest);
      }
    }
    return messages;
  }

  /** 释放单个会话的 CLI 侧数据；是否清理由 provider 的能力声明决定 */
  function dropSessionArtifacts(sessionId: string): void {
    const session = db.getSession(sessionId);
    if (!session) return;
    const ref = session.agentSessionId;
    if (!ref) return;

    const provider = getProvider(session.agentId);
    if (provider?.manifest.capabilities.sessionCleanup) {
      provider.deleteSession(ref, {
        cwd: session.cwd,
        configDir: session.configDir ?? null,
      });
    }
    historyCache.delete(ref);
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
      const { sessionId, prompt, cwd, opts, env, envRemove, extraArgs, onEvent } =
        params;
      const failed = (error: string): RunOutcome => ({
        ok: false,
        exitCode: -1,
        duration: 0,
        aborted: false,
        error,
      });

      const session = db.getSession(sessionId);
      if (!session) return failed(`会话不存在: ${sessionId}`);

      const provider = getProvider(session.agentId);
      if (!provider) return failed(`未知 Agent: ${session.agentId}`);

      // 能力驱动：不支持多轮的 provider 永远按新会话发起
      const canResume =
        provider.manifest.capabilities.resume && !!session.agentSessionId;
      const sessionRef = canResume ? session.agentSessionId : null;

      // 用对象持有闭包内的赋值，避免被控制流分析误判为恒 null
      const captured: { rawId: string | null } = { rawId: null };

      // 持久化用户消息：在运行前落库，确保即使运行失败也能看到原始指令
      const userMsg: Message = {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", content: prompt }],
        timestamp: Date.now(),
      };
      db.saveSessionMessage(sessionId, userMsg);

      // 累积 assistant 消息的事件流（镜像渲染进程的 appendEvent 逻辑）
      let assistantContent: AgentEvent[] = [];

      const runSession = provider.start({
        prompt,
        cwd,
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
      });
      running.set(sessionId, runSession);

      let result;
      try {
        result = await runSession.done;
      } finally {
        running.delete(sessionId);
      }

      // 持久化 assistant 消息：无论成功/失败/中断，已累积的事件流都落库
      if (assistantContent.length > 0) {
        db.saveSessionMessage(sessionId, {
          id: randomUUID(),
          role: "assistant",
          content: assistantContent,
          timestamp: Date.now(),
        });
      }

      // 会话引用规范化 + 落库：语义由 provider 决定，宿主只负责存取。
      // 只要本轮已经拿到 CLI 侧的会话 id，就必须落库 —— 即便本轮被中断/超时，
      // CLI 侧会话依然存在且可恢复。否则用户随后在同一会话里追问时会话引用缺失，
      // Agent 会"失忆"（自动化任务被停止/超时后追问，就是这种表现）。
      if (captured.rawId) {
        const ref = provider.normalizeSessionRef(captured.rawId, { cwd });
        if (ref !== session.agentSessionId) {
          db.updateAgentSessionId(sessionId, ref);
          historyCache.delete(ref);
        }
      }

      return {
        ok: true,
        exitCode: result.exitCode,
        duration: result.duration,
        aborted: runSession.aborted,
      };
    },

    abort(sessionId: string): boolean {
      const runSession = running.get(sessionId);
      if (!runSession) return false;
      // 不在此处移除表项：由 run() 的 finally 统一清理，
      // 这样 run() 才能读到 runSession.aborted 来判断是否被中断
      runSession.abort();
      return true;
    },

    getSessionWithHistory(sessionId: string): Session | null {
      const session = db.getSession(sessionId);
      if (!session) return null;

      // 优先从数据库读取持久化的完整事件流（含工具调用、思考等）。
      // 新会话在 run() 里已落库；老会话（升级前创建的）无 DB 数据，
      // 回退到 provider 从 CLI 侧回放（仅文本，不含工具调用细节）。
      const persisted = db.readSessionMessages(sessionId);
      if (persisted) {
        return { ...session, messages: persisted };
      }
      return { ...session, messages: readHistoryCached(session) };
    },

    releaseSession(sessionId: string): void {
      running.get(sessionId)?.abort();
      dropSessionArtifacts(sessionId);
    },

    releaseProject(projectId: string): void {
      for (const sessionId of db.listSessionIdsByProject(projectId)) {
        dropSessionArtifacts(sessionId);
      }
    },
  };
}
