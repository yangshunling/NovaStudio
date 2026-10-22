/**
 * Agent 相关 IPC：检测 / 发送 / 中断
 */

import type { SendAgentResult } from "../../../shared/contracts/ipc";
import type { AgentService } from "../../engine/agent-service";
import * as db from "../../db/sqlite";
import { flushEvents, push } from "../push";
import { handle } from "../register";

export function registerAgentHandlers(service: AgentService): void {
  handle("agent:detect", async () => {
    const agents = await service.listAgentInfos();
    push("agents:detected", agents);
    return agents;
  });

  /** 模型列表由各 provider 自己查询（pi --list-models / codex debug models / …） */
  handle("agent:models", ({ agentId }) => service.listAgentModels(agentId));

  /**
   * 统一发送：主进程按会话是否已存会话引用、以及 provider 是否支持多轮，
   * 决定新建还是恢复（判断逻辑在 AgentService 内，此处不重复）。
   */
  handle("agent:send", async ({ sessionId, prompt, opts }): Promise<SendAgentResult> => {
    const session = db.getSession(sessionId);
    if (!session) return { ok: false, error: `会话不存在: ${sessionId}` };

    const cwd = service.resolveCwd(session.cwd, db.getSetting("defaultCwd"));

    // 记录用户消息：刷新索引（首条消息写标题），正文不入库
    db.touchSession(sessionId, {
      title: (session.messageCount ?? 0) === 0 ? prompt.slice(0, 40) : undefined,
      countDelta: 1,
    });

    const outcome = await service.run({ sessionId, prompt, cwd, opts });
    if (!outcome.ok) return { ok: false, error: outcome.error ?? "运行失败" };

    flushEvents();

    // 被用户中断的会话不记为完成，也不推送 done
    if (!outcome.aborted) {
      db.touchSession(sessionId, { countDelta: 1 });
      push("agent:done", {
        sessionId,
        exitCode: outcome.exitCode,
        duration: outcome.duration,
      });
    }

    return { ok: true, exitCode: outcome.exitCode, duration: outcome.duration };
  });

  /** 中断指定会话（多会话并发时互不影响） */
  handle("agent:abort", ({ sessionId }) => {
    const aborted = service.abort(sessionId);
    flushEvents();
    return aborted;
  });
}
