/**
 * Git Tab：工作区级 Git 面板
 *
 * 布局按 IDE 的 Source Control 来：
 * - 左：已暂存 / 未暂存 / 未跟踪 / 冲突分组 + 最近提交
 * - 右：选中文件的 diff + 底部提交区
 *
 * 写操作全部走 git:* IPC；UI 只负责确认与刷新，不直接拼命令行。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { Project } from "@shared/types";
import type {
  GitBranchInfo,
  GitCommitSummary,
  GitFileStatus,
  GitStatusDetail,
} from "@shared/git";
import { ipc } from "../../lib/ipc";
import { timeAgo, toMessage } from "../../lib/utils";
import { toast } from "../../stores/toast";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { Dialog, DialogActions } from "../ui/Dialog";
import { Field, TextArea, TextInput } from "../ui/Field";
import { EmptyState } from "../ui/EmptyState";
import {
  conflictedFiles,
  displayStatus,
  GIT_STATUS_META,
  stagedFiles,
  unstagedFiles,
  untrackedFiles,
} from "./gitUi";

export interface GitTabProps {
  project: Project;
  status: GitStatusDetail | null;
  branches: GitBranchInfo[];
  commits: GitCommitSummary[];
  loading: boolean;
  /** 只刷新 Git 状态 / 分支 / 历史 */
  onRefresh: () => void;
  /** 分支切换 / 初始化等会改变工作区文件的操作：同时刷新文件页 */
  onAfterMutation: () => void;
  /** 在文件页打开某个文件 */
  onOpenFile: (relativePath: string) => void;
}

type SelectedFile = {
  relativePath: string;
  staged: boolean;
  untracked: boolean;
};

/** 可折叠的区域：四个变更分组 + 最近提交 */
type GroupKey = "conflict" | "staged" | "unstaged" | "untracked" | "commits";

export function GitTab({
  project,
  status,
  branches,
  commits,
  loading,
  onRefresh,
  onAfterMutation,
  onOpenFile,
}: GitTabProps) {
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [diff, setDiff] = useState("");
  const [diffBinary, setDiffBinary] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitOutput, setCommitOutput] = useState<string | null>(null);

  const [branchToCheckout, setBranchToCheckout] = useState<string | null>(
    null,
  );
  const [checkoutAfterCommit, setCheckoutAfterCommit] = useState<
    string | null
  >(null);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const commitBoxRef = useRef<HTMLDivElement>(null);

  /** 折叠状态按分组记录；默认全部展开 */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<GroupKey>>(
    new Set(),
  );
  const toggleGroup = (key: GroupKey) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const isCollapsed = (key: GroupKey) => collapsedGroups.has(key);

  const staged = useMemo(() => stagedFiles(status), [status]);
  const unstaged = useMemo(() => unstagedFiles(status), [status]);
  const untracked = useMemo(() => untrackedFiles(status), [status]);
  const conflicted = useMemo(() => conflictedFiles(status), [status]);
  const changes = status?.available ? status.files.length : 0;
  const canCommit =
    Boolean(message.trim()) &&
    staged.length > 0 &&
    !busy &&
    status?.available === true;

  // 加载选中文件的 diff
  useEffect(() => {
    if (!selected || selected.untracked) {
      setDiff("");
      setDiffBinary(false);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }

    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    setDiffBinary(false);

    ipc
      .getGitDiff(project.id, selected.relativePath, selected.staged)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setDiff("");
          setDiffError(result.error ?? "无法读取 diff");
          return;
        }
        setDiff(result.diff);
        setDiffBinary(result.binary);
      })
      .catch((err) => {
        if (!cancelled) {
          setDiff("");
          setDiffError(toMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [project.id, selected]);

  // 文件被提交 / 取消暂存后可能从列表消失，或从未跟踪变成已暂存
  useEffect(() => {
    if (!selected || !status?.available) return;
    const entry = status.files.find(
      (file) => file.relativePath === selected.relativePath,
    );
    if (!entry) {
      setSelected(null);
      return;
    }
    if (entry.untracked !== selected.untracked) {
      setSelected({
        relativePath: selected.relativePath,
        staged: entry.untracked ? false : entry.indexStatus !== null,
        untracked: entry.untracked,
      });
    }
  }, [status, selected]);

  const focusCommitBox = () => {
    requestAnimationFrame(() => {
      commitBoxRef.current?.querySelector("textarea")?.focus();
    });
  };

  // ==========================================================================
  // 操作
  // ==========================================================================

  const checkout = async (branch: string) => {
    setBusy("checkout");
    try {
      const result = await ipc.checkoutGitBranch(project.id, branch);
      if (!result.ok) {
        toast.error(result.error ?? "切换分支失败", 6000);
        return;
      }
      toast.success(`已切换到 ${branch}`);
      setSelected(null);
      setMessage("");
      setCommitError(null);
      onAfterMutation();
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setBusy(null);
    }
  };

  const requestCheckout = (branch: string) => {
    if (busy || !status?.available || branch === status.branch) return;
    if (changes > 0) {
      setBranchToCheckout(branch);
      return;
    }
    void checkout(branch);
  };

  const createBranch = async () => {
    if (!newBranchName.trim() || busy) return;
    setBusy("createBranch");
    try {
      const result = await ipc.createGitBranch(
        project.id,
        newBranchName.trim(),
      );
      if (!result.ok) {
        toast.error(result.error ?? "创建分支失败", 6000);
        return;
      }
      toast.success(`已创建并切换到 ${newBranchName.trim()}`);
      setNewBranchOpen(false);
      setNewBranchName("");
      setSelected(null);
      setMessage("");
      onAfterMutation();
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setBusy(null);
    }
  };

  const stage = async (paths: string[]) => {
    if (paths.length === 0 || busy) return;
    setBusy("stage");
    try {
      const result = await ipc.stageGitPaths(project.id, paths);
      if (!result.ok) {
        toast.error(result.error ?? "暂存失败", 6000);
        return;
      }
      if (selected && paths.includes(selected.relativePath)) {
        setSelected({
          relativePath: selected.relativePath,
          staged: true,
          untracked: false,
        });
      }
      onRefresh();
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setBusy(null);
    }
  };

  const unstage = async (paths: string[]) => {
    if (paths.length === 0 || busy) return;
    setBusy("unstage");
    try {
      const result = await ipc.unstageGitPaths(project.id, paths);
      if (!result.ok) {
        toast.error(result.error ?? "取消暂存失败", 6000);
        return;
      }
      if (selected && paths.includes(selected.relativePath)) {
        setSelected({
          relativePath: selected.relativePath,
          staged: false,
          untracked: false,
        });
      }
      onRefresh();
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    if (!canCommit) return;
    setBusy("commit");
    setCommitError(null);
    setCommitOutput(null);
    try {
      const result = await ipc.commitGit(project.id, message);
      if (!result.ok) {
        setCommitError(result.error ?? "提交失败");
        setCommitOutput(result.output ?? null);
        return;
      }
      toast.success("提交成功");
      setMessage("");
      setSelected(null);
      onRefresh();

      if (checkoutAfterCommit) {
        const target = checkoutAfterCommit;
        setCheckoutAfterCommit(null);
        await checkout(target);
      }
    } catch (err) {
      setCommitError(toMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const init = async () => {
    setBusy("init");
    try {
      const result = await ipc.initGitRepository(project.id);
      if (!result.ok) {
        toast.error(result.error ?? "初始化 Git 失败", 6000);
        return;
      }
      toast.success("Git 仓库已初始化");
      onAfterMutation();
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setBusy(null);
    }
  };

  // ==========================================================================
  // 渲染
  // ==========================================================================

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!status.available) {
    const gitMissing =
      Boolean(status.error?.includes("未检测到 git")) ||
      Boolean(status.error?.toLowerCase().includes("not found"));
    return (
      <div className="flex h-full items-center justify-center p-section">
        <div className="max-w-md rounded-xl border border-border/70 bg-surface-2/40 p-6 text-center shadow-[var(--c-shadow-sm)]">
          <GitBranch className="mx-auto h-7 w-7 text-text-muted" />
          <h3 className="mt-2 text-title font-semibold text-text">
            {gitMissing ? "未检测到 Git" : "该工作区还不是 Git 仓库"}
          </h3>
          <p className="mt-1 text-meta text-text-muted">
            {status.error ?? "初始化后可以在这里查看变更、切换分支并提交。"}
          </p>
          {!gitMissing && (
            <Button
              variant="primary"
              className="mt-3"
              size="sm"
              loading={busy === "init"}
              onClick={() => void init()}
            >
              初始化 Git 仓库
            </Button>
          )}
        </div>
      </div>
    );
  }

  const branchOptions = branches.map((branch) => ({
    value: branch.name,
    label: branch.current ? `${branch.name}（当前）` : branch.name,
  }));

  const selectedEntry = selected
    ? (status.files.find(
        (file) => file.relativePath === selected.relativePath,
      ) ?? null)
    : null;
  const selectedDeleted =
    selectedEntry?.worktreeStatus === "deleted" ||
    selectedEntry?.indexStatus === "deleted";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏：分支 / 批量操作 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-card py-2">
        <div className="ui-ring flex h-8 min-w-40 items-center gap-1.5 rounded-full bg-input-bg px-3">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-accent" />
          {branchOptions.length > 0 ? (
            <Select
              value={status.branch ?? ""}
              onChange={requestCheckout}
              options={branchOptions}
              disabled={Boolean(busy)}
              className="text-meta text-text-secondary"
              minMenuWidth={200}
              aria-label="切换分支"
              title="切换分支"
            />
          ) : (
            <span className="text-meta text-text-muted">尚无分支</span>
          )}
        </div>

        {status.detached && (
          <span className="flex items-center gap-1 rounded-full bg-agent-amber/10 px-2 py-0.5 text-caption text-agent-amber">
            <AlertTriangle className="h-3 w-3" />
            detached HEAD
          </span>
        )}
        {status.ahead > 0 && (
          <span className="rounded-full bg-surface-hover px-2 py-0.5 font-mono text-caption text-text-muted">
            ↑{status.ahead}
          </span>
        )}
        {status.behind > 0 && (
          <span className="rounded-full bg-surface-hover px-2 py-0.5 font-mono text-caption text-text-muted">
            ↓{status.behind}
          </span>
        )}

        <Button
          size="xs"
          icon={<Plus className="h-3 w-3" />}
          onClick={() => setNewBranchOpen(true)}
          disabled={Boolean(busy)}
        >
          新建分支
        </Button>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            onClick={() =>
              void stage(
                [...unstaged, ...untracked].map((file) => file.relativePath),
              )
            }
            disabled={Boolean(busy) || unstaged.length + untracked.length === 0}
          >
            全部暂存
          </Button>
          <Button
            size="xs"
            onClick={() =>
              void unstage(staged.map((file) => file.relativePath))
            }
            disabled={Boolean(busy) || staged.length === 0}
          >
            全部取消暂存
          </Button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            title="刷新 Git 状态"
            aria-label="刷新 Git 状态"
            className="ui-btn-round ui-icon-action flex h-8 w-8 items-center justify-center rounded-full text-text-muted disabled:opacity-40"
          >
            <RefreshCw
              className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
            />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：变更 + 历史 */}
        <aside className="flex w-[340px] shrink-0 flex-col border-r border-border">
          {/* 变更列表：占剩余空间，独立滚动 */}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {changes === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <CheckCircle2 className="h-7 w-7 text-success" />
                <p className="text-body font-medium text-text">工作区干净</p>
                <p className="text-meta text-text-muted">
                  没有未提交变更，切换分支或提交都会很安全。
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {conflicted.length > 0 && (
                  <ChangeGroup
                    title="冲突"
                    files={conflicted}
                    kind="conflict"
                    selected={selected}
                    busy={busy}
                    collapsed={isCollapsed("conflict")}
                    onToggleCollapsed={() => toggleGroup("conflict")}
                    onSelect={setSelected}
                    onToggle={() => undefined}
                  />
                )}
                {staged.length > 0 && (
                  <ChangeGroup
                    title="已暂存"
                    files={staged}
                    kind="staged"
                    selected={selected}
                    busy={busy}
                    collapsed={isCollapsed("staged")}
                    onToggleCollapsed={() => toggleGroup("staged")}
                    maxHeightClass="max-h-[48vh]"
                    onSelect={setSelected}
                    onToggle={(file) =>
                      void unstage([file.relativePath])
                    }
                  />
                )}
                {unstaged.length > 0 && (
                  <ChangeGroup
                    title="未暂存"
                    files={unstaged}
                    kind="unstaged"
                    selected={selected}
                    busy={busy}
                    collapsed={isCollapsed("unstaged")}
                    onToggleCollapsed={() => toggleGroup("unstaged")}
                    maxHeightClass="max-h-[48vh]"
                    onSelect={setSelected}
                    onToggle={(file) => void stage([file.relativePath])}
                  />
                )}
                {untracked.length > 0 && (
                  <ChangeGroup
                    title="未跟踪"
                    files={untracked}
                    kind="untracked"
                    selected={selected}
                    busy={busy}
                    collapsed={isCollapsed("untracked")}
                    onToggleCollapsed={() => toggleGroup("untracked")}
                    onSelect={setSelected}
                    onToggle={(file) => void stage([file.relativePath])}
                  />
                )}
              </div>
            )}

          </div>

          {/* 最近提交：展开时固定为父高度的 1/3，折叠后只留标题 */}
          <section
            className={`flex shrink-0 flex-col border-t border-border ${
              isCollapsed("commits") ? "" : "h-1/3"
            }`}
          >
            <button
              type="button"
              aria-expanded={!isCollapsed("commits")}
              onClick={() => toggleGroup("commits")}
              className="flex w-full shrink-0 items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover"
            >
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
                  isCollapsed("commits") ? "-rotate-90" : ""
                }`}
              />
              <span className="flex-1 text-caption font-semibold text-text-secondary">
                最近提交
              </span>
              <span className="font-mono text-caption text-text-muted">
                {commits.length}
              </span>
            </button>
            <div
              className={`min-h-0 flex-1 overflow-y-auto px-2 pb-2 ${
                isCollapsed("commits") ? "hidden" : ""
              }`}
            >
              {commits.length === 0 ? (
                <p className="px-1 py-2 text-caption text-text-muted">
                  {status.hasHead ? "还没有提交记录" : "仓库还没有第一次提交"}
                </p>
              ) : (
                <div className="space-y-0.5">
                  {commits.slice(0, 10).map((commit) => (
                    <div
                      key={commit.hash}
                      title={`${commit.hash}\n${commit.author}`}
                      className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-hover"
                    >
                      <div className="flex items-center gap-1.5">
                        <GitCommitHorizontal className="h-3 w-3 shrink-0 text-text-muted" />
                        <span className="min-w-0 flex-1 truncate text-meta text-text-secondary">
                          {commit.subject}
                        </span>
                        <span className="shrink-0 font-mono text-caption text-text-muted">
                          {commit.shortHash}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 pl-4 text-caption text-text-muted">
                        <span className="truncate">{commit.author}</span>
                        <span className="shrink-0">
                          {timeAgo(commit.date)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </aside>

        {/* 右：diff + 提交 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-meta text-text-secondary">
                {selected?.relativePath ?? "选择左侧变更文件查看 diff"}
              </span>
              {selected && (
                <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-caption text-text-muted">
                  {selected.untracked
                    ? "未跟踪"
                    : selected.staged
                      ? "已暂存"
                      : "未暂存"}
                </span>
              )}
              {selected && !selected.untracked && !selectedDeleted && (
                <Button
                  size="xs"
                  onClick={() => onOpenFile(selected.relativePath)}
                >
                  打开文件
                </Button>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {!selected ? (
                changes === 0 ? (
                  <EmptyState
                    size="compact"
                    icon={<CheckCircle2 />}
                    title="没有未提交变更"
                    description="工作区是干净的。可以切换分支，或从左侧查看最近的提交记录。"
                    className="h-full"
                  />
                ) : (
                  <EmptyState
                    size="compact"
                    icon={<GitBranch />}
                    title="选择一个变更文件"
                    description="点击左侧文件查看 diff；勾选文件可以暂存或取消暂存。"
                    className="h-full"
                  />
                )
              ) : selected.untracked ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-section text-center">
                  <GitBranch className="h-7 w-7 text-text-muted" />
                  <p className="text-body font-medium text-text">
                    未跟踪文件
                  </p>
                  <p className="text-meta text-text-muted">
                    文件还没有被 Git 跟踪，暂存后才能查看 diff。
                  </p>
                  <div className="mt-1 flex gap-2">
                    <Button
                      size="sm"
                      loading={busy === "stage"}
                      onClick={() => void stage([selected.relativePath])}
                    >
                      暂存此文件
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => onOpenFile(selected.relativePath)}
                    >
                      打开文件
                    </Button>
                  </div>
                </div>
              ) : diffLoading ? (
                <div className="flex h-full items-center justify-center text-text-muted">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : diffError ? (
                <div className="m-3 rounded-lg border border-error/25 bg-error-bg px-3 py-2 text-meta text-error">
                  {diffError}
                </div>
              ) : diffBinary ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-section text-center">
                  <AlertTriangle className="h-6 w-6 text-agent-amber" />
                  <p className="text-body font-medium text-text">
                    二进制文件
                  </p>
                  <p className="text-meta text-text-muted">
                    无法以文本方式显示 diff，请用系统程序打开查看。
                  </p>
                </div>
              ) : diff.trim() === "" ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-section text-center">
                  <GitBranch className="h-6 w-6 text-text-muted" />
                  <p className="text-meta text-text-muted">
                    没有可显示的 diff（文件可能已删除或内容未变化）。
                  </p>
                </div>
              ) : (
                <DiffView diff={diff} />
              )}
            </div>
          </div>

          {/* 提交区 */}
          {changes > 0 && (
            <div
              ref={commitBoxRef}
              className="shrink-0 border-t border-border p-card"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-meta font-semibold text-text-secondary">
                  提交信息
                </span>
                <span className="font-mono text-caption text-text-muted">
                  {staged.length} 个文件已暂存
                </span>
              </div>

              <TextArea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="描述这次变更…"
                rows={3}
                className="mt-2"
              />

              {checkoutAfterCommit && (
                <p className="mt-1.5 flex items-center gap-2 text-caption text-agent-amber">
                  提交成功后将自动切换到 {checkoutAfterCommit}。
                  <button
                    type="button"
                    onClick={() => setCheckoutAfterCommit(null)}
                    className="font-medium underline underline-offset-2"
                  >
                    取消
                  </button>
                </p>
              )}

              {commitError && (
                <div className="mt-2 rounded-lg border border-error/25 bg-error-bg px-2.5 py-2 text-caption text-error">
                  <p>{commitError}</p>
                  {commitOutput && (
                    <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-caption opacity-80">
                      {commitOutput}
                    </pre>
                  )}
                </div>
              )}

              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-caption text-text-muted">
                  {staged.length === 0
                    ? "先在左侧勾选要提交的文件"
                    : message.trim()
                      ? `将提交 ${staged.length} 个文件`
                      : "填写提交信息后即可提交"}
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  loading={busy === "commit"}
                  disabled={!canCommit}
                  onClick={() => void commit()}
                >
                  提交
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 有未提交变更时切换分支的确认 */}
      <Dialog
        open={Boolean(branchToCheckout)}
        onClose={() => setBranchToCheckout(null)}
        title="切换分支"
        width="sm"
      >
        <p className="text-meta leading-relaxed text-text-secondary">
          当前有 <strong className="text-text">{changes}</strong>{" "}
          个未提交变更。直接切换会把变更带到新分支；如果与目标分支冲突，
          Git 会拒绝切换。
        </p>
        <DialogActions>
          <Button
            onClick={() => setBranchToCheckout(null)}
            disabled={Boolean(busy)}
          >
            取消
          </Button>
          <Button
            onClick={() => {
              setCheckoutAfterCommit(branchToCheckout);
              setBranchToCheckout(null);
              focusCommitBox();
            }}
            disabled={Boolean(busy)}
          >
            提交后切换
          </Button>
          <Button
            variant="primary"
            loading={busy === "checkout"}
            onClick={() => {
              const branch = branchToCheckout;
              setBranchToCheckout(null);
              if (branch) void checkout(branch);
            }}
          >
            仍然切换
          </Button>
        </DialogActions>
      </Dialog>

      {/* 新建分支 */}
      <Dialog
        open={newBranchOpen}
        onClose={() => setNewBranchOpen(false)}
        title="新建分支"
        width="sm"
        description="将基于当前 HEAD 创建并立即切换。"
      >
        <Field label="分支名称" required>
          <TextInput
            value={newBranchName}
            onChange={(event) => setNewBranchName(event.target.value)}
            placeholder="feature/my-change"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter") void createBranch();
            }}
          />
        </Field>
        <DialogActions>
          <Button
            onClick={() => {
              setNewBranchOpen(false);
              setNewBranchName("");
            }}
            disabled={Boolean(busy)}
          >
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy === "createBranch"}
            disabled={!newBranchName.trim() || Boolean(busy)}
            onClick={() => void createBranch()}
          >
            创建并切换
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}

// ============================================================================
// 变更分组
// ============================================================================

function ChangeGroup({
  title,
  files,
  kind,
  selected,
  busy,
  collapsed,
  onToggleCollapsed,
  maxHeightClass = "max-h-[32vh]",
  onSelect,
  onToggle,
}: {
  title: string;
  files: GitFileStatus[];
  kind: "staged" | "unstaged" | "untracked" | "conflict";
  selected: SelectedFile | null;
  busy: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 展开时的最大高度；已暂存 / 未暂存传更大的值 */
  maxHeightClass?: string;
  onSelect: (file: SelectedFile) => void;
  onToggle: (file: GitFileStatus) => void;
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
        className="mb-1 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-surface-hover"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
            collapsed ? "-rotate-90" : ""
          }`}
        />
        <span
          className={`flex-1 text-caption font-semibold ${
            kind === "conflict" ? "text-error" : "text-text-secondary"
          }`}
        >
          {title}
        </span>
        <span className="font-mono text-caption text-text-muted">
          {files.length}
        </span>
      </button>

      {/* 展开后给足高度，超出部分在分组内滚动，不影响其它分组 */}
      <div
        className={`${maxHeightClass} space-y-0.5 overflow-y-auto overscroll-contain ${
          collapsed ? "hidden" : ""
        }`}
      >
        {files.map((file) => {
          const stagedFlag = kind === "staged";
          const untrackedFlag = kind === "untracked";
          const active =
            selected?.relativePath === file.relativePath &&
            selected?.staged === stagedFlag &&
            selected?.untracked === untrackedFlag;
          const status = displayStatus(file);
          const meta = GIT_STATUS_META[status];
          const name =
            file.relativePath.split("/").pop() ?? file.relativePath;
          const parent = parentPath(file.relativePath);

          return (
            <div
              key={`${kind}:${file.relativePath}`}
              className={`flex items-center gap-1.5 rounded-md px-1.5 py-1.5 transition-colors ${
                active ? "bg-surface-active" : "hover:bg-surface-hover"
              }`}
            >
              {kind !== "conflict" ? (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => onToggle(file)}
                  title={
                    stagedFlag ? "取消暂存" : "暂存此文件"
                  }
                  aria-label={stagedFlag ? "取消暂存" : "暂存此文件"}
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors disabled:opacity-40 ${
                    stagedFlag
                      ? "border-accent bg-accent text-accent-foreground"
                      : "border-border-strong bg-transparent text-transparent hover:border-accent"
                  }`}
                >
                  <Check className="h-3 w-3" />
                </button>
              ) : (
                <span className="grid h-4 w-4 shrink-0 place-items-center text-error">
                  <AlertTriangle className="h-3.5 w-3.5" />
                </span>
              )}

              <button
                type="button"
                onClick={() =>
                  onSelect({
                    relativePath: file.relativePath,
                    staged: stagedFlag,
                    untracked: untrackedFlag,
                  })
                }
                title={file.relativePath}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-meta text-text-secondary">
                    {name}
                  </span>
                  {parent && (
                    <span className="block truncate font-mono text-caption text-text-muted">
                      {parent}
                    </span>
                  )}
                </span>
                <span
                  className={`shrink-0 font-mono text-caption font-semibold ${meta.textClass}`}
                  title={meta.text}
                >
                  {meta.label}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Diff
// ============================================================================

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  const added = lines.filter(
    (line) => line.startsWith("+") && !line.startsWith("+++"),
  ).length;
  const removed = lines.filter(
    (line) => line.startsWith("-") && !line.startsWith("---"),
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-3 py-1.5 font-mono text-caption">
        <span className="text-success">+{added}</span>
        <span className="text-error">-{removed}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <pre className="min-w-max p-3 font-mono text-caption leading-relaxed">
          {lines.map((line, index) => {
            let className = "text-text-secondary";
            if (
              line.startsWith("diff --git") ||
              line.startsWith("index ") ||
              line.startsWith("---") ||
              line.startsWith("+++")
            ) {
              className = "text-text-muted";
            } else if (line.startsWith("@@")) {
              className = "text-accent";
            } else if (line.startsWith("+")) {
              className = "bg-success/10 text-success";
            } else if (line.startsWith("-")) {
              className = "bg-error/10 text-error";
            }

            return (
              <div key={index} className={`px-2 ${className}`}>
                {line || " "}
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

function parentPath(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index >= 0 ? relativePath.slice(0, index) : "";
}
