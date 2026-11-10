/**
 * 工作区 Git 集成
 *
 * 与 status.ts（文件树标记）分开：这里提供 Git 面板需要的完整能力 ——
 * 暂存 / 未暂存 / 未跟踪、分支、diff、提交历史与提交操作。
 *
 * 所有命令都通过 execFile 以参数数组执行，不经过 shell，避免路径 / 分支名
 * 被解释成命令；文件路径统一相对工作区解析并做越界校验。
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { GitStatusKind } from "../../shared/types";
import { clamp } from "../../shared/math";
import type {
  GitBranchInfo,
  GitCommitSummary,
  GitDiffResult,
  GitFileStatus,
  GitOperationResult,
  GitStatusDetail,
} from "../../shared/git";
import { isInside } from "../utils/paths";
import { errorMessage } from "../../shared/error";

const GIT_TIMEOUT_MS = 20_000;
/** 推送 / 拉取 / 获取要等网络，超时放宽 */
const GIT_REMOTE_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** diff 超过这个长度就截断，避免渲染进程被超大 diff 卡死 */
const MAX_DIFF_CHARS = 400_000;

interface GitRunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  message: string;
}

function runGit(
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<GitRunResult> {
  return new Promise((resolveRun) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException).code === "number"
            ? Number((error as NodeJS.ErrnoException).code)
            : error
              ? 1
              : 0;
        resolveRun({
          ok: !error,
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          message: error instanceof Error ? error.message : "",
        });
      },
    );
  });
}

function emptyStatus(error: string): GitStatusDetail {
  return {
    available: false,
    repoRoot: null,
    branch: null,
    detached: false,
    ahead: 0,
    behind: 0,
    hasHead: false,
    files: [],
    error,
  };
}

/** 读取工作区（可能是仓库子目录）的完整 Git 状态 */
export async function readStatusDetail(cwd: string): Promise<GitStatusDetail> {
  const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) {
    const reason =
      root.message.includes("ENOENT") || root.message.includes("not found")
        ? "未检测到 git 命令"
        : "该工作区不是 Git 仓库";
    return emptyStatus(reason);
  }

  const repoRoot = root.stdout.trim();
  if (!repoRoot) return emptyStatus("无法定位 Git 仓库");

  /*
   * Windows 下 cwd 可能是 8.3 短路径（如 YANGSL~1），而 git 返回的是长路径；
   * 直接用 relative 会把同一目录算成越界。两边都 realpath 后再比较。
   */
  let realRoot = repoRoot;
  let realCwd = cwd;
  try {
    [realRoot, realCwd] = await Promise.all([
      realpath(repoRoot),
      realpath(cwd),
    ]);
  } catch {
    // 路径不可解析时保留原值，后续校验仍会拦住真正的越界
  }

  const prefix = relative(realRoot, realCwd)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (prefix === ".." || prefix.startsWith("../")) {
    return emptyStatus("工作区不在仓库目录内");
  }

  const [status, head] = await Promise.all([
    runGit(cwd, [
      "status",
      "--porcelain=v1",
      "-z",
      "--branch",
      "--untracked-files=all",
    ]),
    runGit(cwd, ["rev-parse", "--verify", "HEAD"]),
  ]);

  if (!status.ok) {
    return emptyStatus(status.stderr.trim() || "无法读取 Git 状态");
  }

  const parsed = parsePorcelain(status.stdout, prefix);
  return {
    available: true,
    repoRoot: realRoot,
    branch: parsed.branch,
    detached: parsed.detached,
    ahead: parsed.ahead,
    behind: parsed.behind,
    hasHead: head.ok,
    files: parsed.files,
  };
}

interface ParsedStatus {
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

function parsePorcelain(raw: string, prefix: string): ParsedStatus {
  const records = raw.split("\0");
  const files: GitFileStatus[] = [];
  let branch: string | null = null;
  let detached = false;
  let ahead = 0;
  let behind = 0;

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;

    if (record.startsWith("## ")) {
      const header = record.slice(3);
      if (header.startsWith("HEAD (no branch)")) {
        detached = true;
        branch = "HEAD";
      } else if (header.startsWith("No commits yet on ")) {
        branch = header.slice("No commits yet on ".length).trim() || null;
      } else {
        const branchPart = header.split("...")[0].trim();
        branch = branchPart || null;
        const aheadMatch = /ahead (\d+)/.exec(header);
        const behindMatch = /behind (\d+)/.exec(header);
        if (aheadMatch) ahead = Number(aheadMatch[1]);
        if (behindMatch) behind = Number(behindMatch[1]);
      }
      continue;
    }

    if (record.length < 4) continue;

    const indexChar = record[0];
    const worktreeChar = record[1];
    const repoPath = record.slice(3).replace(/\\/g, "/");
    if (!repoPath) continue;

    // 重命名 / 复制记录后面还跟一个原路径，跳过它
    if (indexChar === "R" || indexChar === "C") i += 1;

    const relativePath = relativeToWorkspace(repoPath, prefix);
    if (!relativePath) continue;

    if (indexChar === "?" && worktreeChar === "?") {
      files.push({
        relativePath,
        indexStatus: null,
        worktreeStatus: null,
        untracked: true,
        conflicted: false,
      });
      continue;
    }
    if (indexChar === "!" && worktreeChar === "!") continue;

    const conflicted =
      indexChar === "U" ||
      worktreeChar === "U" ||
      (indexChar === "A" && worktreeChar === "A") ||
      (indexChar === "D" && worktreeChar === "D");

    const indexStatus = mapStatusChar(indexChar);
    const worktreeStatus = mapStatusChar(worktreeChar);
    if (!indexStatus && !worktreeStatus && !conflicted) continue;

    files.push({
      relativePath,
      indexStatus: conflicted ? null : indexStatus,
      worktreeStatus: conflicted ? null : worktreeStatus,
      untracked: false,
      conflicted,
    });
  }

  return { branch, detached, ahead, behind, files };
}

function relativeToWorkspace(
  repoPath: string,
  prefix: string,
): string | null {
  const normalizedPrefix = prefix.replace(/\/+$/, "");
  if (!normalizedPrefix) return repoPath;
  if (repoPath === normalizedPrefix) return null;
  if (!repoPath.startsWith(`${normalizedPrefix}/`)) return null;
  return repoPath.slice(normalizedPrefix.length + 1);
}

function mapStatusChar(char: string): GitStatusKind | null {
  switch (char) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    case "T":
      return "changed";
    default:
      return null;
  }
}

/** 本地分支列表（当前分支带 current 标记） */
export async function listBranches(cwd: string): Promise<GitBranchInfo[]> {
  const result = await runGit(cwd, [
    "branch",
    "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)",
  ]);
  if (!result.ok) return [];

  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream] = line.split("\t");
      return {
        name: name ?? "",
        current: (head ?? "").trim() === "*",
        upstream: (upstream ?? "").trim() || null,
      };
    })
    .filter((branch) => Boolean(branch.name) && !branch.name.startsWith("("));
}

/** 最近提交历史；空仓库返回空数组 */
export async function readLog(
  cwd: string,
  limit = 20,
): Promise<GitCommitSummary[]> {
  const count = clamp(Math.round(limit), 1, 100);
  const result = await runGit(cwd, [
    "log",
    `-n${count}`,
    "--pretty=format:%H%x00%h%x00%an%x00%at%x00%s%x00%D%x1e",
  ]);
  if (!result.ok) return [];

  return result.stdout
    .split("\x1e")
    .map((record) => record.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, author, at, subject, refs] =
        record.split("\x00");
      const timestamp = Number(at);
      return {
        hash: hash ?? "",
        shortHash: shortHash ?? "",
        author: author ?? "",
        date: Number.isFinite(timestamp) ? timestamp * 1000 : 0,
        subject: subject ?? "",
        refs: (refs ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      };
    })
    .filter((commit) => Boolean(commit.hash));
}

/** 读取单个文件的 diff：staged=true 看暂存区，否则看工作区 */
export async function readDiff(
  cwd: string,
  relativePath: string,
  staged: boolean,
): Promise<GitDiffResult> {
  try {
    validatePath(cwd, relativePath);
  } catch (err) {
    return {
      ok: false,
      diff: "",
      binary: false,
      truncated: false,
      error: errorMessage(err),
    };
  }

  const args = ["diff", "--no-color", "--relative"];
  if (staged) args.push("--cached");
  args.push("--", relativePath);

  const result = await runGit(cwd, args);
  if (!result.ok) {
    return {
      ok: false,
      diff: "",
      binary: false,
      truncated: false,
      error: result.stderr.trim() || "无法读取 diff",
    };
  }

  const diff = result.stdout;
  const binary =
    diff.includes("Binary files") || diff.includes("GIT binary patch");
  const truncated = diff.length > MAX_DIFF_CHARS;

  return {
    ok: true,
    diff: truncated
      ? `${diff.slice(0, MAX_DIFF_CHARS)}\n\n…（diff 过大，已截断）`
      : diff,
    binary,
    truncated,
  };
}

/** 暂存文件（含删除 / 重命名） */
export async function stagePaths(
  cwd: string,
  paths: string[],
): Promise<GitOperationResult> {
  return runPathOperation(cwd, paths, (safePaths) => [
    "add",
    "-A",
    "--",
    ...safePaths,
  ]);
}

/** 取消暂存；空仓库没有 HEAD，用 git rm --cached */
export async function unstagePaths(
  cwd: string,
  paths: string[],
): Promise<GitOperationResult> {
  const head = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  return runPathOperation(cwd, paths, (safePaths) =>
    head.ok
      ? ["reset", "HEAD", "--", ...safePaths]
      : ["rm", "--cached", "-r", "--", ...safePaths],
  );
}

async function runPathOperation(
  cwd: string,
  paths: string[],
  buildArgs: (safePaths: string[]) => string[],
): Promise<GitOperationResult> {
  let safePaths: string[];
  try {
    safePaths = paths.map((path) => validatePath(cwd, path));
  } catch (err) {
    return {
      ok: false,
      error: errorMessage(err),
    };
  }
  if (safePaths.length === 0) return { ok: true };

  const result = await runGit(cwd, buildArgs(safePaths));
  return {
    ok: result.ok,
    error: result.ok ? undefined : result.stderr.trim() || "Git 操作失败",
    output: `${result.stdout}${result.stderr}`.trim() || undefined,
  };
}

/** 提交已暂存内容 */
export async function commitChanges(
  cwd: string,
  message: string,
): Promise<GitOperationResult> {
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, error: "提交信息不能为空" };

  const result = await runGit(cwd, ["commit", "-m", trimmed]);
  if (result.ok) {
    return { ok: true, output: result.stdout.trim() || undefined };
  }
  return {
    ok: false,
    error:
      result.stderr.trim() ||
      result.stdout.trim() ||
      "提交失败，请检查是否有已暂存变更",
    output: `${result.stdout}${result.stderr}`.trim() || undefined,
  };
}

// ============================================================================
// 远端操作
// ============================================================================

/** 当前分支的 upstream（如 origin/main）；没有跟踪分支时返回 null */
async function readUpstream(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (!result.ok) return null;
  const upstream = result.stdout.trim();
  return upstream && upstream !== "@{u}" ? upstream : null;
}

/** 推送当前分支；首次推送时自动建立 upstream 跟踪（优先 origin） */
export async function pushBranch(
  cwd: string,
  branch: string,
): Promise<GitOperationResult> {
  if (branch === "HEAD") {
    return { ok: false, error: "detached HEAD 状态下无法推送" };
  }
  try {
    validateBranch(branch);
  } catch (err) {
    return {
      ok: false,
      error: errorMessage(err),
    };
  }

  if (await readUpstream(cwd)) {
    return runGitOperation(cwd, ["push"], "推送失败", GIT_REMOTE_TIMEOUT_MS);
  }

  const remotes = await runGit(cwd, ["remote"]);
  if (!remotes.ok) {
    return {
      ok: false,
      error: remotes.stderr.trim() || "无法读取远端列表",
    };
  }
  const names = remotes.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    return { ok: false, error: "仓库没有配置远端（remote）" };
  }

  const remote = names.includes("origin") ? "origin" : names[0];
  try {
    validateRemote(remote);
  } catch (err) {
    return {
      ok: false,
      error: errorMessage(err),
    };
  }

  return runGitOperation(
    cwd,
    ["push", "-u", remote, branch],
    "推送失败",
    GIT_REMOTE_TIMEOUT_MS,
  );
}

/** 拉取当前分支：只允许 fast-forward，避免自动产生合并提交 */
export async function pullBranch(cwd: string): Promise<GitOperationResult> {
  if (!(await readUpstream(cwd))) {
    return {
      ok: false,
      error: "当前分支没有 upstream，请先推送一次建立跟踪",
    };
  }
  return runGitOperation(
    cwd,
    ["pull", "--ff-only"],
    "拉取失败",
    GIT_REMOTE_TIMEOUT_MS,
  );
}

/** 切换分支 */
export async function checkoutBranch(
  cwd: string,
  branch: string,
): Promise<GitOperationResult> {
  try {
    validateBranch(branch);
  } catch (err) {
    return {
      ok: false,
      error: errorMessage(err),
    };
  }

  const result = await runGit(cwd, ["checkout", branch]);
  return {
    ok: result.ok,
    error: result.ok
      ? undefined
      : result.stderr.trim() || "切换分支失败（可能有未提交变更）",
  };
}

/** 创建并切换到新分支 */
export async function createBranch(
  cwd: string,
  name: string,
): Promise<GitOperationResult> {
  try {
    validateBranch(name);
  } catch (err) {
    return {
      ok: false,
      error: errorMessage(err),
    };
  }

  const result = await runGit(cwd, ["checkout", "-b", name.trim()]);
  return {
    ok: result.ok,
    error: result.ok
      ? undefined
      : result.stderr.trim() || "创建分支失败",
  };
}

/** 初始化 Git 仓库 */
export async function initRepository(cwd: string): Promise<GitOperationResult> {
  const result = await runGit(cwd, ["init"]);
  return {
    ok: result.ok,
    error: result.ok ? undefined : result.stderr.trim() || "初始化 Git 失败",
  };
}

// ============================================================================
// 参数校验
// ============================================================================

/** 文件路径必须相对工作区且不能越界；不要求文件存在（删除的文件也要能操作） */
function validatePath(root: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").trim();
  if (!normalized || normalized.includes("\0")) {
    throw new Error("文件路径不合法");
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("文件路径必须相对工作区");
  }

  const target = resolve(root, normalized);
  if (!isInside(resolve(root), target)) {
    throw new Error("文件路径超出工作区");
  }
  return normalized;
}

/** 执行不涉及具体文件的 Git 命令，统一整理成功输出与失败信息 */
async function runGitOperation(
  cwd: string,
  args: string[],
  fallbackError: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<GitOperationResult> {
  const result = await runGit(cwd, args, timeoutMs);
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.ok) return { ok: true, output: output || undefined };
  return {
    ok: false,
    error: result.stderr.trim() || result.stdout.trim() || fallbackError,
    output: output || undefined,
  };
}

/** 远端名来自 git remote，仍按引用规则再校验一次，避免被当成命令行参数 */
function validateRemote(remote: string): string {
  const name = remote.trim();
  if (
    !name ||
    name.startsWith("-") ||
    name.includes("..") ||
    /[\s~^:?*\[\]\\]/.test(name) ||
    name.includes("\0")
  ) {
    throw new Error("远端名称不合法");
  }
  return name;
}

/** 分支名不做复杂推断，但拦住明显的命令行注入与非法字符 */
function validateBranch(branch: string): string {
  const name = branch.trim();
  if (!name) throw new Error("分支名称不能为空");
  if (
    name.startsWith("-") ||
    name.endsWith("/") ||
    name.includes("..") ||
    name.includes("//") ||
    name.endsWith(".lock") ||
    /[\s~^:?*\[\]\\]/.test(name) ||
    name.includes("\0")
  ) {
    throw new Error("分支名称不合法");
  }
  return name;
}
