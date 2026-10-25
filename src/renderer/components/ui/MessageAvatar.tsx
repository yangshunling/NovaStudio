/**
 * 消息头图标 — 对话两侧的身份标识
 *
 * 左侧是回复方（当前会话使用的 Agent），右侧是发起方（Nova）。
 * Agent 头像按 id 取品牌图形，未知 Agent 回退为通用机器人图标并使用
 * manifest 的 tone 槽位配色，因此换肤后会自动融入。
 *
 * 组件只认识「品牌图形」这一层展示知识，不影响 provider / 会话逻辑。
 */

import { Bot } from "lucide-react";
import claudeAvatarUrl from "../../assets/claude.png";
import logoUrl from "../../assets/logo.png";
import { agentTone, getAgentName } from "../../lib/utils";
import type { AgentInfo } from "@shared/contracts/agent";

/** 头像容器的统一尺寸与圆角；描边由各品牌自行决定 */
const AVATAR_BASE =
  "flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full";

/** 回复方头像：当前会话的 Agent */
export function AgentAvatar({
  agents,
  agentId,
  className = "",
}: {
  agents: AgentInfo[];
  agentId: string;
  className?: string;
}) {
  const tone = agentTone(agents, agentId);
  const isClaude = agentId === "claude";

  return (
    <span
      title={getAgentName(agents, agentId)}
      className={`${AVATAR_BASE} ${
        isClaude ? "" : `${tone.soft} ${tone.fg}`
      } ${className}`}
    >
      {isClaude ? (
        <img
          src={claudeAvatarUrl}
          alt="Claude"
          className="h-full w-full object-cover"
        />
      ) : (
        <Bot className="h-4 w-4" />
      )}
    </span>
  );
}

/** 发起方头像：Nova */
export function NovaAvatar({ className = "" }: { className?: string }) {
  return (
    <span
      title="Nova"
      className={`${AVATAR_BASE} bg-accent-soft ${className}`}
    >
      {/* logo 自带透明留白，稍微放大让标记的视觉大小与 Claude 头像接近 */}
      <img
        src={logoUrl}
        alt="Nova"
        className="h-full w-full scale-125 object-cover"
      />
    </span>
  );
}
