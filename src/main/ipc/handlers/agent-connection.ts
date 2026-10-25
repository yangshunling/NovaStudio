/**
 * Agent 连接配置 IPC
 *
 * Nova 自管的接入信息（Base URL / API Key / 默认模型）与连通性测试。
 * 密钥只在主进程解密使用，任何返回值都不包含明文。
 */

import { shell } from "electron";
import {
  CLAUDE_AGENT_ID,
  ensureClaudeSettingsFile,
  getAgentConnectionView,
  importLocalClaudeConnection,
  probeClaudeModels,
  saveClaudeConnection,
  testClaudeConnection,
} from "../../agents/claude/connection";
import { handle } from "../register";

export function registerAgentConnectionHandlers(): void {
  handle("agent:connection:get", ({ agentId }) =>
    getAgentConnectionView(agentId),
  );

  handle("agent:connection:save", ({ draft }) => saveClaudeConnection(draft));

  handle("agent:connection:models", ({ input }) => probeClaudeModels(input));

  handle("agent:connection:test", ({ input }) => testClaudeConnection(input));

  handle("agent:connection:importLocal", ({ agentId }) => {
    if (agentId !== CLAUDE_AGENT_ID) {
      throw new Error(`当前仅支持导入 Claude Code 的本机配置（收到：${agentId}）`);
    }
    return importLocalClaudeConnection();
  });

  handle("agent:connection:openConfig", ({ agentId }) => {
    if (agentId !== CLAUDE_AGENT_ID) return false;
    const path = ensureClaudeSettingsFile();
    if (!path) return false;
    shell.showItemInFolder(path);
    return true;
  });
}
