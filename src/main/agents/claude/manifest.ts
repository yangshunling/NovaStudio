/**
 * Claude Code 的静态元数据
 *
 * Claude Code 支持 --resume 恢复会话，会话数据存放在 CLI 侧的 JSONL 文件里，
 * 需要同步清理。
 *
 * 不再声明用户可调的运行参数：会话与工作流如何运行完全由本机
 * `~/.claude/settings.json` 决定（权限、模型、接入配置等）。
 */

import type { AgentManifest } from "../../../shared/contracts/agent";

export const manifest: AgentManifest = {
  id: "claude",
  displayName: "Claude Code",
  order: 30,
  tone: "sky",
  capabilities: {
    resume: true,
    sessionCleanup: true,
    skills: true,
    mcp: true,
  },
  installCommand: "npm install -g @anthropic-ai/claude-code",
};
