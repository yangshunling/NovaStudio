/**
 * 周报生成
 *
 * 复用 provider 的一次性文本生成能力（不建会话、不落历史、禁用工具）：
 * 宿主负责按周期取待办并组装 prompt，模型只负责组织文字。
 *
 * 之所以不通过聊天会话生成：周报是「点一下、拿到一段成品」的动作，
 * 把整份待办清单作为用户消息写进会话历史，既污染记录也不利于后续
 * 由触发器复用同一套逻辑。
 */

import { homedir } from "node:os";
import * as db from "../db/sqlite";
import { resolveCompletionProvider } from "../agents/complete";
import {
  buildWeeklyReportPrompt,
  collectReportBundle,
  stripReportMarkdown,
  type ReportRange,
  type WeeklyReportOptions,
} from "../../shared/report";

/** 周报通常比提交信息长，但仍要防止无限等待 */
const GENERATE_TIMEOUT_MS = 120_000;

export interface GenerateWeeklyReportInput {
  range: ReportRange;
  options: WeeklyReportOptions;
  /** 增量输出，供渲染层实时预览 */
  onChunk?: (chunk: string) => void;
  /** 取消信号 */
  signal?: AbortSignal;
}

/** 生成一份周报草稿；无可用记录时直接抛错，避免白跑一次模型 */
export async function generateWeeklyReport(
  input: GenerateWeeklyReportInput,
): Promise<string> {
  const bundle = collectReportBundle(db.listTodos(), input.range, input.options);
  if (bundle.entries.length === 0) {
    throw new Error("所选周期没有符合条件的记录");
  }

  const provider = resolveCompletionProvider("自动生成周报");
  const raw = await provider.complete({
    prompt: buildWeeklyReportPrompt(bundle, input.range, input.options),
    cwd: db.getSetting("defaultCwd")?.trim() || homedir(),
    timeoutMs: GENERATE_TIMEOUT_MS,
    onChunk: input.onChunk,
    signal: input.signal,
  });

  const markdown = stripReportMarkdown(raw);
  if (!markdown) throw new Error("模型没有返回内容，请重试");
  return markdown;
}
