/**
 * Git 工作区状态读取
 *
 * 使用 porcelain v1 + -z，避免文件名中的空格、引号和换行破坏解析。
 * --relative 让返回路径直接相对于当前项目目录，而不是 Git 仓库根目录。
 */

import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import type {
  GitFileStatus,
  GitStatusKind,
  GitStatusSummary,
} from "../../shared/types";

const execFileAsync = promisify(execFile);

const EMPTY_STATUS: GitStatusSummary = {
  available: false,
  branch: null,
  files: [],
};

export async function readGitStatus(cwd: string): Promise<GitStatusSummary> {
  if (!cwd) return EMPTY_STATUS;

  try {
    const { stdout: rootOutput } = await runGit(cwd, [
      "rev-parse",
      "--show-toplevel",
    ]);
    const repoRoot = String(rootOutput).trim();
    if (!repoRoot) return EMPTY_STATUS;

    const projectPrefix = relative(repoRoot, cwd).replace(/\\/g, "/");
    if (projectPrefix === ".." || projectPrefix.startsWith("../")) {
      return EMPTY_STATUS;
    }

    const { stdout: statusOutput } = await runGit(cwd, [
      "status",
      "--porcelain=v1",
      "-z",
      "--branch",
      "--untracked-files=all",
    ]);
    return parseGitStatus(String(statusOutput), projectPrefix);
  } catch {
    return EMPTY_STATUS;
  }
}

function runGit(cwd: string, args: string[]) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function parseGitStatus(
  raw: string,
  projectPrefix = "",
): GitStatusSummary {
  const records = raw.split("\0");
  const files: GitFileStatus[] = [];
  let branch: string | null = null;

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;

    if (record.startsWith("## ")) {
      const header = record.slice(3);
      if (header.startsWith("HEAD (no branch)")) {
        branch = "HEAD";
      } else {
        branch = header
          .split("...")[0]
          .replace(/^No commits yet on /, "")
          .trim() || null;
      }
      continue;
    }

    if (record.length < 4) continue;

    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const repoPath = record.slice(3).replace(/\\/g, "/").replace(/^\.\//, "");
    if (!repoPath) continue;

    // porcelain -z 的重命名 / 复制记录后面还会跟一个原路径，跳过它。
    if (indexStatus === "R" || indexStatus === "C") i += 1;

    const relativePath = relativeToProject(repoPath, projectPrefix);
    if (!relativePath) continue;

    files.push({
      relativePath,
      status: classifyStatus(indexStatus, worktreeStatus),
    });
  }

  return {
    available: true,
    branch,
    files,
  };
}

function relativeToProject(repoPath: string, projectPrefix: string): string | null {
  const prefix = projectPrefix.replace(/\/+$/, "");
  if (!prefix) return repoPath;
  if (repoPath === prefix) return null;
  if (!repoPath.startsWith(`${prefix}/`)) return null;
  return repoPath.slice(prefix.length + 1);
}

function classifyStatus(indexStatus: string, worktreeStatus: string): GitStatusKind {
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";

  if (
    indexStatus === "U" ||
    worktreeStatus === "U" ||
    (indexStatus === "A" && worktreeStatus === "A") ||
    (indexStatus === "D" && worktreeStatus === "D")
  ) {
    return "conflicted";
  }

  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  if (indexStatus === "R") return "renamed";
  if (indexStatus === "C") return "copied";
  if (indexStatus === "A") return "added";
  if (
    indexStatus === "M" ||
    worktreeStatus === "M" ||
    indexStatus === "T" ||
    worktreeStatus === "T"
  ) {
    return "modified";
  }

  return "changed";
}
