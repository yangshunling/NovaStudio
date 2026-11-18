/**
 * 会话标题总结
 *
 * 与提交信息 / 周报共用 provider 的一次性文本生成能力（不建会话、不落历史、
 * 不开工具）。调用方先用本地规则写一个临时标题，这里只在模型返回后覆盖；
 * 覆盖前以数据库现状为准，避免把用户手动改过的标题冲掉。
 */

import { resolveCompletionProvider } from "../agents/complete";
import * as db from "../db/sqlite";
import {
  SESSION_TITLE_SCHEMA,
  buildSessionTitlePrompt,
  extractStructuredTitle,
  normalizeSessionTitle,
} from "../../shared/session-title";

/** 标题总结是小任务，失败就保留临时标题，不能让请求长期挂着 */
const TITLE_TIMEOUT_MS = 30_000;

export interface GenerateSessionTitleInput {
  sessionId: string;
  /** 首条问题的展示正文；为空（纯图片 / 仅引用）时跳过模型 */
  question: string;
  /** 一次性生成使用的工作目录 */
  cwd: string;
  /** 调用方已写入的临时标题：数据库里的标题被改过就不再覆盖 */
  fallbackTitle: string;
}

/** 返回最终写入的标题；跳过或失败时返回 null（保留临时标题） */
export async function generateSessionTitle(
  input: GenerateSessionTitleInput,
): Promise<string | null> {
  const question = input.question.trim();
  if (!question) return null;

  let provider: ReturnType<typeof resolveCompletionProvider>;
  try {
    provider = resolveCompletionProvider("自动生成会话标题");
  } catch (err) {
    console.warn("[session] 无法自动生成标题：", err);
    return null;
  }

  try {
    const raw = await provider.complete({
      prompt: buildSessionTitlePrompt(question),
      cwd: input.cwd,
      timeoutMs: TITLE_TIMEOUT_MS,
      // 结构化输出：让模型直接返回 { title }，不再从自然语言里猜正文
      jsonSchema: SESSION_TITLE_SCHEMA,
    });
    const title = normalizeSessionTitle(extractStructuredTitle(raw));
    if (!title) return null;

    /*
     * 生成期间会话可能已被删除，用户也可能手动改名。
     * 只有标题仍是调用方写入的临时值时才覆盖：用户的选择优先。
     */
    const latest = db.getSession(input.sessionId);
    if (!latest || latest.title !== input.fallbackTitle) return null;

    db.setSessionTitle(input.sessionId, title);
    return title;
  } catch (err) {
    // 标题只是锦上添花：失败保留临时标题，不影响本轮对话
    console.warn("[session] 自动生成标题失败，保留临时标题：", err);
    return null;
  }
}
