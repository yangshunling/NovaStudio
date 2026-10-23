/**
 * 渲染进程共享工具函数
 *
 * 集中放置跨组件复用的纯函数，避免在每个组件内重复定义。
 */

import type { AgentEvent } from "@shared/types";
import type { AgentInfo, AgentTone } from "@shared/contracts/agent";

/** 生成随机 ID（crypto.randomUUID 包装） */
export function newId(): string {
  return crypto.randomUUID();
}

/** 取路径最后一段作为名称（兼容 Windows 反斜杠） */
export function dirName(path: string): string {
  if (!path) return "未命名";
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** 相对时间：刚刚 / N分钟前 / N小时前 / N天前 */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  return `${d}天前`;
}

/** 截断长文本，超过 max 显示前 max 字符 + 省略号 */
export function truncateHead(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 截断长文本，超过 max 追加折叠提示（主要用于代码/输出展示） */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…（共 ${text.length} 字符，已截断）`;
}

/** 从 AgentEvent 数组中取第一个 text 块（用户消息展示用） */
export function firstText(events: AgentEvent[]): string {
  return events.find((e) => e.type === "text")?.content ?? "";
}

/**
 * 从 Agent 列表按 id 查找显示名称。
 * 找不到时回退到 agentId 本身。
 */
export function getAgentName(agents: AgentInfo[], agentId: string): string {
  return agents.find((a) => a.id === agentId)?.displayName ?? agentId;
}

/**
 * 槽位 → 类名。键取自 AgentManifest.tone（契约里的联合类型保证这里不会漏）。
 * 类名必须写成字面量，Tailwind 才扫得到。
 */
const TONE_CLASSES: Record<AgentTone, { fg: string; soft: string }> = {
  amber: { fg: "text-agent-amber", soft: "bg-agent-amber/15" },
  violet: { fg: "text-agent-violet", soft: "bg-agent-violet/15" },
  sky: { fg: "text-agent-sky", soft: "bg-agent-sky/15" },
  teal: { fg: "text-agent-teal", soft: "bg-agent-teal/15" },
  rose: { fg: "text-agent-rose", soft: "bg-agent-rose/15" },
  lime: { fg: "text-agent-lime", soft: "bg-agent-lime/15" },
};

/** 未声明 tone 或 Agent 已不存在（如历史会话所属的 Agent 被卸载）：中性灰 */
const NEUTRAL_TONE = { fg: "text-text-muted", soft: "bg-surface-hover" };

/**
 * 取某 Agent 的标识色类名。
 *
 * 组件不认任何具体 Agent，只按 manifest 声明的槽位取色 ——
 * 新增 Agent 时挑个空闲槽位即可，本文件与所有调用方都无需改动。
 */
export function agentTone(
  agents: AgentInfo[],
  agentId: string,
): { fg: string; soft: string } {
  const tone = agents.find((a) => a.id === agentId)?.tone;
  return tone ? TONE_CLASSES[tone] : NEUTRAL_TONE;
}

/**
 * 判断工具结果是否为错误。
 * 只看 provider 给出的 isError 标记 —— 是否出错属于协议知识，
 * provider 的解析层负责把它判对，展示层不猜输出文本。
 */
export function isToolResultError(result: { isError?: boolean }): boolean {
  return result.isError === true;
}