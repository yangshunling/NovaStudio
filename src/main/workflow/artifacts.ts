/**
 * 工作流产物与临时运行目录
 *
 * 产物（用户可见、可追溯）落在工作区：
 *   <workspace>/.novastudio/workflows/<workflowId>/<run>/<node>/
 * - run 目录名：时间戳 + 运行 id 前缀
 * - node 目录名：执行序号 + 节点名称；重试使用同级的 `<node>.try-N`
 *
 * Provider 的运行时投影（临时 mcp.json / 配置目录副本）落在应用数据目录：
 *   <userData>/workflow-runs/<runId>/<node>-attempt-N/
 * 节点结束后由运行器删除；这里只负责启动时的异常退出兜底清理。
 */

import { mkdir, readdir, rm, rmdir, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { WorkflowNode } from "../../shared/types";

/** 一次运行在工作区里的产物根目录 */
export function createRunArtifactDir(
  workspacePath: string,
  workflowId: string,
  runId: string,
): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  return join(
    workspacePath,
    ".novastudio",
    "workflows",
    workflowId,
    `${stamp}_${runId.slice(0, 8)}`,
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
 * 单次节点尝试的产物目录。
 *
 * 首次尝试直接用 `<序号>-<节点名>`；重试使用同级 `<序号>-<节点名>.try-N`，
 * 不再为每次尝试多加一层目录。序号保证同名节点不会互相覆盖。
 */
export function nodeArtifactDir(
  runDir: string,
  node: WorkflowNode,
  index: number,
  attempt: number,
): string {
  const label =
    safeSegment(node.name).slice(0, 40) || node.id.slice(0, 8);
  const base = join(
    runDir,
    `${String(Math.max(0, index) + 1).padStart(2, "0")}-${label}`,
  );
  return attempt > 1 ? `${base}.try-${attempt}` : base;
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

/** 异常退出遗留的运行目录保留上限：超过后下次启动清理 */
const RUNTIME_RETENTION_MS = 30 * 60 * 1000;

/**
 * 启动时清理异常退出遗留的运行时目录。
 *
 * 只清理 30 分钟前的目录：正常运行的目录 mtime 很新，不会误删
 * （也为多实例启动留出安全边界）。
 */
export async function purgeStaleWorkflowRuntimes(
  userDataDir: string,
): Promise<void> {
  const root = join(userDataDir, "workflow-runs");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const path = join(root, entry.name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs < RUNTIME_RETENTION_MS) return;
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
    // 仍有活跃 / 新目录时保留
  }
}
