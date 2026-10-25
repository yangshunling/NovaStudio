/**
 * Skill 展示元数据
 *
 * 页面与员工绑定 Tab 共用同一份来源标签与配色。
 */

import type { SkillOrigin } from "@shared/types";

export const SKILL_ORIGIN_LABEL: Record<SkillOrigin, string> = {
  "claude-global": "Claude 全局",
  "agents-store": "共享技能库",
};

export const SKILL_ORIGIN_CLASS: Record<SkillOrigin, string> = {
  "claude-global": "bg-agent-violet/10 text-agent-violet",
  "agents-store": "bg-agent-teal/10 text-agent-teal",
};
