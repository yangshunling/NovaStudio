/**
 * Agent 相关 IPC：检测 / 发送 / 中断
 */

import { shell } from "electron";
import type { SendAgentResult } from "../../../shared/contracts/ipc";
import { getProvider } from "../../agents/registry";
import {
  getClaudeSettingsView,
  saveClaudeSettings,
} from "../../agents/claude/settings";
import { listClaudeModels } from "../../agents/claude/models";
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

  handle("agent:settings:get", ({ agentId }) => {
    if (agentId !== "claude") {
      throw new Error(`暂不支持编辑该 Agent 的本机配置：${agentId}`);
    }
    return getClaudeSettingsView();
  });

  handle("agent:settings:save", ({ draft }) => saveClaudeSettings(draft));

  /** 按当前 Base URL / API Key 拉取可用模型（仅 Claude 兼容端点） */
  handle("agent:models:list", ({ agentId, baseUrl, apiKey }) => {
    if (agentId !== "claude") {
      throw new Error(`暂不支持获取该 Agent 的模型列表：${agentId}`);
    }
    return listClaudeModels(baseUrl, apiKey);
  });

  /** 打开某个 Agent 的本机配置目录 */
  handle("agent:openConfigDir", async ({ agentId }) => {
    const provider = getProvider(agentId);
    const config = provider?.configInfo?.();
    if (!config?.configPath) return false;

    const error = await shell.openPath(config.configPath);
    if (!error) return true;
    shell.showItemInFolder(config.configPath);
    return true;
  });

  /**
   * 统一发送：主进程按会话是否已存会话引用、以及 provider 是否支持多轮，
   * 决定新建还是恢复（判断逻辑在 AgentService 内，此处不重复）。
   */
  handle("agent:send", async ({ sessionId, prompt }): Promise<SendAgentResult> => {
    const session = db.getSession(sessionId);
    if (!session) return { ok: false, error: `会话不存在: ${sessionId}` };

    const cwd = service.resolveCwd(session.cwd, db.getSetting("defaultCwd"));

    // 记录用户消息：刷新索引（首条消息写标题），正文不入库
    db.touchSession(sessionId, {
      title: (session.messageCount ?? 0) === 0 ? prompt.slice(0, 40) : undefined,
      countDelta: 1,
    });

    const outcome = await service.run({ sessionId, prompt, cwd });
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
