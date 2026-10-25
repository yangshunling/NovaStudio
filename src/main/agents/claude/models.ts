/**
 * Claude Code 的模型列表
 *
 * 模型来源已改为 **Nova 自管的连接配置**（「运行环境 → Agent 配置」），
 * 不再读取本机 `~/.claude/settings.json`。这样页面下拉里的模型、
 * 工作流节点实际使用的端点与密钥来自同一份配置，不会出现错位。
 *
 * 查询失败时回落到上次成功缓存的列表；没有缓存则返回空数组，
 * 由 UI 回退为手动输入。
 */

import type { AgentModelOption } from "../../../shared/contracts/agent";
import {
  CLAUDE_AGENT_ID,
  getClaudeConnection,
  probeClaudeModels,
} from "./connection";

export async function listModels(): Promise<AgentModelOption[]> {
  const result = await probeClaudeModels({
    agentId: CLAUDE_AGENT_ID,
    baseUrl: "",
    model: "",
  });

  if (result.ok && result.models && result.models.length > 0) {
    return result.models;
  }

  return getClaudeConnection().models;
}
