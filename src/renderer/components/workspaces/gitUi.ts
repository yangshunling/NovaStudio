/**
 * Git 面板的展示映射：状态字母 / 颜色 / 统计。
 */

import type { GitStatusKind } from "@shared/types";
import type { GitFileStatus, GitStatusDetail } from "@shared/git";
import { GIT_STATUS_LABELS, GIT_STATUS_TEXT } from "@shared/git";

export interface GitStatusMeta {
  label: string;
  text: string;
  badge: string;
  dot: string;
  /** 只给图标 / 字母用的文字颜色 */
  textClass: string;
}

export const GIT_STATUS_META: Record<GitStatusKind, GitStatusMeta> = {
  untracked: {
    label: GIT_STATUS_LABELS.untracked,
    text: GIT_STATUS_TEXT.untracked,
    badge: "bg-success/10 text-success",
    dot: "bg-success",
    textClass: "text-success",
  },
  added: {
    label: GIT_STATUS_LABELS.added,
    text: GIT_STATUS_TEXT.added,
    badge: "bg-success/10 text-success",
    dot: "bg-success",
    textClass: "text-success",
  },
  modified: {
    label: GIT_STATUS_LABELS.modified,
    text: GIT_STATUS_TEXT.modified,
    badge: "bg-agent-amber/10 text-agent-amber",
    dot: "bg-agent-amber",
    textClass: "text-agent-amber",
  },
  deleted: {
    label: GIT_STATUS_LABELS.deleted,
    text: GIT_STATUS_TEXT.deleted,
    badge: "bg-error/10 text-error",
    dot: "bg-error",
    textClass: "text-error",
  },
  renamed: {
    label: GIT_STATUS_LABELS.renamed,
    text: GIT_STATUS_TEXT.renamed,
    badge: "bg-agent-sky/10 text-agent-sky",
    dot: "bg-agent-sky",
    textClass: "text-agent-sky",
  },
  copied: {
    label: GIT_STATUS_LABELS.copied,
    text: GIT_STATUS_TEXT.copied,
    badge: "bg-agent-teal/10 text-agent-teal",
    dot: "bg-agent-teal",
    textClass: "text-agent-teal",
  },
  conflicted: {
    label: GIT_STATUS_LABELS.conflicted,
    text: GIT_STATUS_TEXT.conflicted,
    badge: "bg-error/10 text-error",
    dot: "bg-error",
    textClass: "text-error",
  },
  changed: {
    label: GIT_STATUS_LABELS.changed,
    text: GIT_STATUS_TEXT.changed,
    badge: "bg-surface-hover text-text-muted",
    dot: "bg-text-muted",
    textClass: "text-text-muted",
  },
};

/** 文件在列表里展示的单个状态：优先工作区状态 */
export function displayStatus(file: GitFileStatus): GitStatusKind {
  if (file.conflicted) return "conflicted";
  if (file.untracked) return "untracked";
  return file.worktreeStatus ?? file.indexStatus ?? "changed";
}

/** 已暂存文件（index 有状态） */
export function stagedFiles(status: GitStatusDetail | null): GitFileStatus[] {
  if (!status?.available) return [];
  return status.files.filter(
    (file) => !file.conflicted && file.indexStatus !== null,
  );
}

/** 未暂存文件（worktree 有状态，且不是未跟踪） */
export function unstagedFiles(
  status: GitStatusDetail | null,
): GitFileStatus[] {
  if (!status?.available) return [];
  return status.files.filter(
    (file) =>
      !file.conflicted && !file.untracked && file.worktreeStatus !== null,
  );
}

/** 未跟踪文件 */
export function untrackedFiles(
  status: GitStatusDetail | null,
): GitFileStatus[] {
  if (!status?.available) return [];
  return status.files.filter((file) => file.untracked);
}

/** 冲突文件 */
export function conflictedFiles(
  status: GitStatusDetail | null,
): GitFileStatus[] {
  if (!status?.available) return [];
  return status.files.filter((file) => file.conflicted);
}

/** Git 变更的独立文件数（同一文件既有暂存又有未暂存时只算一次） */
export function changeCount(status: GitStatusDetail | null): number {
  return status?.available ? status.files.length : 0;
}
