/**
 * 会话级运行时编排
 *
 * 本模块只负责“宿主侧”的职责：
 * - 为每个会话分配稳定的运行时根目录与共享 projects 目录；
 * - 把同一会话的运行时准备串行化，避免并发删建链接；
 * - 把具体的 home 布局 / CLI 参数交给 Agent provider。
 *
 * Claude 的 claude-home、mcp.json、--mcp-config 等细节见
 * `agents/claude/chat-runtime.ts`；新增 Agent 只需实现
 * `AgentProvider.prepareChatRun`，本文件无需改动。
 */

import { rm, rmdir } from "fs/promises";
import { join } from "path";
import type { DigitalEmployee, Session } from "../../shared/types";
import { DATA_DIR } from "../utils/paths";
import { getProvider } from "../agents/registry";
import type { AgentProvider, ChatRuntimePaths } from "../agents/types";

/**
 * 会话运行时根目录：~/.novastudio/runtime/<sessionId>/
 *
 * 员工的工作流运行时也在同一根目录下（<employeeId>）。
 * 两者 id 都是 UUID，不会冲突。
 */
const RUNTIME_ROOT = join(DATA_DIR, "runtime");

function assertSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error("非法会话 id");
  }
}

/** 会话运行时根目录 */
export function sessionRuntimeDir(sessionId: string): string {
  assertSessionId(sessionId);
  return join(RUNTIME_ROOT, sessionId);
}

/** 会话共享的 CLI projects 目录 */
export function sessionProjectsDir(sessionId: string): string {
  return join(sessionRuntimeDir(sessionId), "projects");
}

/** 传给 provider 的会话级路径（provider 不得自行推导） */
function chatRuntimePaths(sessionId: string): ChatRuntimePaths {
  return {
    root: sessionRuntimeDir(sessionId),
    projectsDir: sessionProjectsDir(sessionId),
  };
}

function providerFor(agentId: string): AgentProvider {
  const provider = getProvider(agentId);
  if (!provider) throw new Error(`未知 Agent：${agentId}`);
  return provider;
}

export interface SessionChatPreparation {
  /**
   * 本轮使用的 CLI 配置目录。
   * provider 不需要会话级运行时时为 null（沿用 CLI 默认配置）。
   */
  configDir: string | null;
  /** 本轮子进程追加的环境变量（例如 CLAUDE_CONFIG_DIR） */
  env?: Record<string, string>;
  /** 本轮子进程需要剔除的环境变量 */
  envRemove?: string[];
  extraArgs: string[];
  /** 员工人设 + 知识库；base 轮次为通用助手提示词 */
  systemPrompt?: string;
  warnings: string[];
}

/**
 * 同一会话的运行时准备串行执行。
 *
 * 用户可能在 @ 员工后立刻发送：session:setEmployee 的提前物化与
 * agent:send 的发送前物化会并发进入。排队可以避免两边同时删/建链接。
 */
const sessionQueues = new Map<string, Promise<unknown>>();

function enqueueSession<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = sessionQueues.get(sessionId);
  const run = (previous ?? Promise.resolve()).catch(() => undefined).then(task);
  sessionQueues.set(sessionId, run);
  void run
    .finally(() => {
      if (sessionQueues.get(sessionId) === run) {
        sessionQueues.delete(sessionId);
      }
    })
    .catch(() => {
      // 队列清理不参与错误传播
    });
  return run;
}

/**
 * 为一轮聊天准备运行时。
 *
 * @param employee null 表示本轮不指定员工，使用通用助手环境。
 */
export function prepareSessionChatRun(
  session: Session,
  employee: DigitalEmployee | null,
): Promise<SessionChatPreparation> {
  return enqueueSession(session.id, async () => {
    const provider = providerFor(session.agentId);
    if (!provider.prepareChatRun) {
      // 不需要会话级运行时的 Agent：沿用 CLI 默认配置
      return {
        configDir: session.configDir ?? null,
        extraArgs: [],
        warnings: [],
      };
    }

    const prepared = await provider.prepareChatRun({
      session,
      employee,
      paths: chatRuntimePaths(session.id),
      purpose: "send",
    });

    return {
      configDir: prepared.configDir,
      env: prepared.env,
      envRemove: prepared.envRemove,
      extraArgs: prepared.extraArgs ?? [],
      systemPrompt: prepared.systemPrompt,
      warnings: prepared.warnings ?? [],
    };
  });
}

/**
 * 会话创建时提前准备通用助手环境。
 * 返回 CLI 配置目录，供 sessions.config_dir 记录；null 表示无需记录。
 */
export function ensureSessionBaseRuntime(
  session: Session,
): Promise<string | null> {
  return enqueueSession(session.id, async () => {
    const provider = providerFor(session.agentId);
    if (!provider.prepareChatRun) return session.configDir ?? null;

    const prepared = await provider.prepareChatRun({
      session,
      employee: null,
      paths: chatRuntimePaths(session.id),
      purpose: "materialize",
    });
    return prepared.configDir;
  });
}

/**
 * 用户 @ / 选中某个员工时提前准备该员工的 home。
 * 发送时还会再检查一次，确保技能 / MCP 是最新的。
 */
export function ensureSessionEmployeeRuntime(
  session: Session,
  employee: DigitalEmployee,
): Promise<{ home: string | null; warnings: string[] }> {
  return enqueueSession(session.id, async () => {
    const provider = providerFor(session.agentId);
    if (!provider.prepareChatRun) {
      return { home: session.configDir ?? null, warnings: [] };
    }

    const prepared = await provider.prepareChatRun({
      session,
      employee,
      paths: chatRuntimePaths(session.id),
      purpose: "materialize",
    });
    return {
      home: prepared.configDir,
      warnings: prepared.warnings ?? [],
    };
  });
}

/** 删除某个会话的运行时目录；链接只删链接，不会碰全局技能 */
export async function removeSessionRuntime(sessionId: string): Promise<void> {
  await rm(sessionRuntimeDir(sessionId), {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  }).catch(() => {
    // 删除失败不影响会话记录
  });
  await rmdir(RUNTIME_ROOT).catch(() => {});
}
