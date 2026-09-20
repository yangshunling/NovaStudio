/**
 * Agent 标记药丸 — 名称 + 标识色
 *
 * 标识色取自该 Agent 在 manifest 里声明的 tone 槽位（见 lib/utils.agentTone），
 * 本组件不认识任何具体 Agent —— 新增 Agent 或换肤都无需改动。
 * 侧栏会话、看板任务卡片、任务详情抽屉共用同一种呈现。
 */

import { Bot } from "lucide-react";
import { agentTone, getAgentName } from "../../lib/utils";
import type { AgentInfo } from "@shared/contracts/agent";

export function AgentPill({
  agents,
  agentId,
  iconSize = 12,
  maxWidth = "max-w-[100px]",
  className = "",
}: {
  agents: AgentInfo[];
  agentId: string;
  /** 图标边长（px） */
  iconSize?: number;
  maxWidth?: string;
  className?: string;
}) {
  const tone = agentTone(agents, agentId);

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption ${tone.soft} ${tone.fg} ${className}`}
    >
      <Bot size={iconSize} className="shrink-0" />
      <span className={`truncate ${maxWidth}`}>{getAgentName(agents, agentId)}</span>
    </span>
  );
}
