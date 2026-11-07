/**
 * Git 集成 — 主进程与渲染层共用的数据模型
 *
 * 与 `project:gitStatus`（文件树用的轻量状态）不同，这里是工作区 Git 面板
 * 需要的完整信息：暂存 / 未暂存 / 未跟踪、ahead/behind、分支、diff、提交。
 */

import type { GitStatusKind } from "./types";

export interface GitFileStatus {
  /** 相对工作区根目录的 POSIX 路径 */
  relativePath: string;
  /** 暂存区状态；null 表示没有暂存变更 */
  indexStatus: GitStatusKind | null;
  /** 工作区状态；null 表示没有未暂存变更 */
  worktreeStatus: GitStatusKind | null;
  /** 未跟踪文件 */
  untracked: boolean;
  /** 冲突文件 */
  conflicted: boolean;
}

export interface GitStatusDetail {
  available: boolean;
  /** 仓库根目录；工作区可能是仓库的一个子目录 */
  repoRoot: string | null;
  branch: string | null;
  detached: boolean;
  /** 相对 upstream 的领先 / 落后提交数 */
  ahead: number;
  behind: number;
  /** 是否已有提交（空仓库时为 false） */
  hasHead: boolean;
  files: GitFileStatus[];
  /** 不可用时的原因（未安装 git / 不是仓库） */
  error?: string;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  upstream: string | null;
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** Unix 毫秒时间戳 */
  date: number;
  /** 提交上的引用，如 HEAD -> main、origin/main */
  refs: string[];
}

export interface GitDiffResult {
  ok: boolean;
  diff: string;
  binary: boolean;
  /** diff 过大被截断 */
  truncated: boolean;
  error?: string;
}

export interface GitOperationResult {
  ok: boolean;
  error?: string;
  /** 命令 stdout / stderr，便于在提交失败时展示原始信息 */
  output?: string;
}

/** 染色状态 → 单字母标记，与文件树 / Git 面板共用 */
export const GIT_STATUS_LABELS: Record<GitStatusKind, string> = {
  untracked: "U",
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  conflicted: "!",
  changed: "T",
};

/** 状态 → 中文名 */
export const GIT_STATUS_TEXT: Record<GitStatusKind, string> = {
  untracked: "未跟踪",
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  copied: "复制",
  conflicted: "冲突",
  changed: "类型变更",
};
