/**
 * 工作流产物与遗留运行目录
 *
 * 产物（用户可见、可追溯）落在工作区：
 *   <workspace>/.novastudio/workflows/<workflowId>/<runId>/<node>/
 * - run 目录名：完整运行 id（本身就是唯一标识，不再叠加时间戳）
 * - node 目录名：执行序号 + 节点名称；重试使用同级的 `<node>.try-N`
 *
 * 员工运行时（settings / 凭证 / skills / mcp）由 employees/runtime 统一维护：
 *   ~/.novastudio/employee-runtime/<employeeId>/
 * 聊天与工作流共用，不再为每个执行尝试生成临时投影目录。
 *
 * 旧版本曾在 <userData>/workflow-runs 下按 attempt 复制配置与凭证，
 * 这里只负责启动时一次性清理这批遗留目录。
 */

import { mkdir, readdir, rm, rmdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { WorkflowNode } from "../../shared/types";

/** 一次运行在工作区里的产物根目录 */
export function createRunArtifactDir(
  workspacePath: string,
  workflowId: string,
  runId: string,
): string {
  return join(
    workspacePath,
    ".novastudio",
    "workflows",
    workflowId,
    runId,
  );
}

/** 去掉文件系统不允许的字符，并压掉首尾空白 */
function safeSegment(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
}

/**
 * 单次节点调用的产物目录。
 *
 * 首次尝试直接用 `<序号>-<节点名>`；
 * 执行失败重试用同级 `.try-N`，人工要求修改用同级 `.rev-N`。
 * 两者可以叠加（例如第 2 次尝试的第 2 轮 = `.try-2.rev-2`）。
 * 序号保证同名节点不会互相覆盖。
 */
export function nodeArtifactDir(
  runDir: string,
  node: WorkflowNode,
  index: number,
  attempt: number,
  round = 1,
): string {
  const label =
    safeSegment(node.name).slice(0, 40) || node.id.slice(0, 8);
  const base = join(
    runDir,
    `${String(Math.max(0, index) + 1).padStart(2, "0")}-${label}`,
  );
  const attemptSuffix = attempt > 1 ? `.try-${attempt}` : "";
  const roundSuffix = round > 1 ? `.rev-${round}` : "";
  return `${base}${attemptSuffix}${roundSuffix}`;
}

/**
 * 初始化 .novastudio。
 *
 * 目录内部的 .gitignore 写 `*`：Git 会把整个目录视为全部忽略，
 * 不需要改动用户工作区根目录的 .gitignore。
 */
export async function ensureArtifactsRoot(workspacePath: string): Promise<void> {
  const root = join(workspacePath, ".novastudio");
  await mkdir(root, { recursive: true });
  const gitignore = join(root, ".gitignore");
  if (!existsSync(gitignore)) {
    await writeFile(gitignore, "*\n", "utf8");
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2));
}

/** 把长文本压到指定长度，供下游提示词使用 */
export function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n…（已截断）` : trimmed;
}

/**
 * 启动时清理旧版本遗留的临时运行目录。
 *
 * 旧版为每个 attempt 在 `<userData>/workflow-runs` 下复制一份配置与凭证；
 * 改用员工常驻目录后这里不会再产生新内容。应用只允许单实例，且这里在
 * 注册首个工作流之前执行，启动瞬间不可能有活跃节点，可以安全地全部删除；
 * 尽早清掉也能避免旧凭证副本长期留在磁盘。
 */
export async function purgeLegacyWorkflowRuntimes(
  userDataDir: string,
): Promise<void> {
  const root = join(userDataDir, "workflow-runs");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const path = join(root, entry.name);
      try {
        await rm(path, {
          recursive: true,
          force: true,
          maxRetries: 4,
          retryDelay: 120,
        });
      } catch {
        // 单个目录清理失败不影响其它目录
      }
    }),
  );

  try {
    await rmdir(root);
  } catch {
    // 仍有新目录时保留
  }
}
