/**
 * 提示词 IPC
 *
 * 常用提示词的增删改查，与工作区 / 会话没有依赖关系。
 * 正文按用户原样保存（保留内部的换行与缩进），只校验非空。
 */

import * as db from "../../db/sqlite";
import { handle } from "../register";
import type { PromptDraft } from "../../../shared/types";

const MAX_TITLE_LENGTH = 120;
const MAX_CONTENT_LENGTH = 200_000;
const MAX_TAGS = 8;

/** 去掉 # 前缀、空标签与大小写重复项，顺序保持用户输入顺序 */
function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().replace(/^#+/, "").trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function normalizeDraft(draft: PromptDraft): PromptDraft {
  const title = (draft.title ?? "").trim();
  if (!title) throw new Error("提示词标题不能为空");
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error(`提示词标题不能超过 ${MAX_TITLE_LENGTH} 个字符`);
  }

  const content = draft.content ?? "";
  if (!content.trim()) throw new Error("提示词内容不能为空");
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error("提示词内容过长");
  }

  return {
    title,
    content,
    tags: normalizeTags(draft.tags),
    favorite: Boolean(draft.favorite),
  };
}

export function registerPromptHandlers(): void {
  handle("prompts:list", () => db.listPrompts());

  handle("prompts:create", ({ draft }) => db.createPrompt(normalizeDraft(draft)));

  handle("prompts:update", ({ id, draft }) =>
    db.updatePrompt(id, normalizeDraft(draft)),
  );

  handle("prompts:delete", ({ id }) => db.deletePrompt(id));
}
