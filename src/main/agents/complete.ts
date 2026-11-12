/**
 * 一次性文本生成的 provider 选择
 *
 * 「不建会话、不开工具、只要最终文本」的场景（提交信息、周报草稿等）
 * 共用同一套选择规则：优先设置里的默认 Agent，其次第一个具备该能力的
 * provider。这里只做选择，不关心 prompt 内容。
 */

import type { AgentProvider } from "./types";
import { getProvider, listProviders } from "./registry";
import * as db from "../db/sqlite";

/** 已确认具备一次性生成能力的 provider */
export type CompletionProvider = AgentProvider & {
  complete: NonNullable<AgentProvider["complete"]>;
};

/**
 * @param purpose 错误信息里的动作说明，例如「自动生成提交信息」
 */
export function resolveCompletionProvider(purpose: string): CompletionProvider {
  const configured = db.getSetting("defaultAgent")?.trim() ?? "";
  if (configured) {
    const preferred = getProvider(configured);
    if (preferred?.complete) return preferred as CompletionProvider;
    if (preferred) {
      throw new Error(`${preferred.manifest.displayName} 不支持${purpose}`);
    }
  }

  const fallback = listProviders().find((provider) => provider.complete);
  if (!fallback) throw new Error(`当前 Agent 不支持${purpose}`);
  return fallback as CompletionProvider;
}
