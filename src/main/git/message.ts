/**
 * 根据暂存区差异自动生成 Git 提交信息。
 *
 * 职责拆分：
 * - Git 侧（本文件）：收集已暂存文件、diff 与最近提交风格，整理成 prompt
 * - Agent 侧（provider.complete）：一次性文本生成，不建会话、不开工具
 *
 * 只有已暂存的内容会被提交，因此这里也只把暂存区作为依据；
 * 未暂存 / 未跟踪的文件不参与生成。
 */

import { errorMessage } from "../../shared/error";
import {
  GIT_STATUS_TEXT,
  type GitCommitMessageResult,
  type GitFileStatus,
} from "../../shared/git";
import { resolveCompletionProvider } from "../agents/complete";
import { readLog, readStagedDiff, readStatusDetail } from "./detail";

/** 送进 prompt 的 diff 上限：再长也不会让摘要更准确，只是更贵更慢 */
const PROMPT_DIFF_LIMIT = 48_000;
/** 参考风格用的最近提交条数 */
const RECENT_COMMIT_LIMIT = 8;
/** 生成超时：小任务不应无限等待 */
const GENERATE_TIMEOUT_MS = 120_000;
/** 最终提交信息长度上限，防御模型输出整篇说明 */
const MAX_MESSAGE_CHARS = 1200;

/** 暂存文件 → prompt 里的单行描述 */
function describeFile(file: GitFileStatus): string {
  const status = file.indexStatus
    ? GIT_STATUS_TEXT[file.indexStatus]
    : "变更";
  const renamed = file.originalPath
    ? `（原路径：${file.originalPath}）`
    : "";
  return `- ${status} ${file.relativePath}${renamed}`;
}

function buildPrompt(input: {
  files: string[];
  recent: string[];
  diff: string;
  truncated: boolean;
}): string {
  const sections = [
    "你是 Git 提交信息生成助手。请根据下面已暂存的代码变更，生成一条准确、简洁的提交信息。",
    "",
    "要求：",
    "1. 只输出提交信息本身，不要解释、不要前缀、不要代码块标记、不要加引号。",
    "2. 第一行是摘要，使用祈使句，概括这次变更的目的；中文或英文均可，尽量与「最近提交」的语言和风格保持一致，不超过 72 个字符。",
    "3. 如果有多个独立改动，在摘要后空一行，用「- 」列出要点，最多 5 条；单一改动不必写正文。",
    "4. 只依据下面的文件列表与 diff，不要臆测未出现的改动。",
    "5. 不要调用任何工具，不要修改任何文件。",
  ];

  if (input.recent.length > 0) {
    sections.push(
      "",
      "## 最近提交（仅用于参考语言与风格）",
      ...input.recent.map((subject) => `- ${subject}`),
    );
  }

  sections.push("", "## 暂存文件", ...input.files, "", "## 变更 diff", "```diff");
  sections.push(input.diff);
  sections.push("```");
  if (input.truncated) {
    sections.push("", "（diff 过长已截断，请基于可见部分概括整体改动。）");
  }

  return sections.join("\n");
}

/**
 * 清理模型的输出：
 * - 整段被 ``` 包裹
 * - 「提交信息：」之类的前缀
 * - 整体成对的引号
 */
function sanitizeCommitMessage(raw: string): string {
  let text = raw.trim();
  if (!text) return "";

  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1].trim();

  text = text
    .replace(/^(提交信息|commit message|git commit message)\s*[:：]\s*/i, "")
    .trim();

  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    const paired =
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "“" && last === "”");
    if (paired) text = text.slice(1, -1).trim();
  }

  return text.length > MAX_MESSAGE_CHARS
    ? text.slice(0, MAX_MESSAGE_CHARS).trimEnd()
    : text;
}

/** 根据暂存区差异生成提交信息；所有失败都收敛成 ok:false，不向 IPC 抛错 */
export async function generateCommitMessage(
  cwd: string,
): Promise<GitCommitMessageResult> {
  const status = await readStatusDetail(cwd);
  if (!status.available) {
    return { ok: false, error: status.error ?? "无法读取 Git 状态" };
  }
  if (status.files.some((file) => file.conflicted)) {
    return { ok: false, error: "存在未解决的冲突，解决后再生成提交信息" };
  }

  const staged = status.files.filter(
    (file) => file.indexStatus !== null,
  );
  if (staged.length === 0) {
    return { ok: false, error: "没有已暂存的变更" };
  }

  const diffResult = await readStagedDiff(cwd);
  if (!diffResult.ok) {
    return { ok: false, error: diffResult.error ?? "无法读取暂存区 diff" };
  }

  const truncated = diffResult.diff.length > PROMPT_DIFF_LIMIT;
  const diff = truncated
    ? `${diffResult.diff.slice(0, PROMPT_DIFF_LIMIT)}\n…（已截断）`
    : diffResult.diff;

  const recent = (await readLog(cwd, RECENT_COMMIT_LIMIT))
    .map((commit) => commit.subject.trim())
    .filter(Boolean)
    .map((subject) =>
      subject.length > 100 ? `${subject.slice(0, 100)}…` : subject,
    );

  const prompt = buildPrompt({
    files: staged.map(describeFile),
    recent,
    diff,
    truncated,
  });

  try {
    const provider = resolveCompletionProvider("自动生成提交信息");
    const raw = await provider.complete!({
      prompt,
      cwd,
      timeoutMs: GENERATE_TIMEOUT_MS,
    });
    const message = sanitizeCommitMessage(raw);
    if (!message) {
      return { ok: false, error: "模型没有返回有效的提交信息，请重试" };
    }
    return { ok: true, message };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
