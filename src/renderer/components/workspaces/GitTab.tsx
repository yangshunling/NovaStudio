/**
 * Git Tab：工作区级 Git 面板
 *
 * 布局按 IDE 的 Source Control 来：
 * - 左：已暂存 / 未暂存（含未跟踪）/ 冲突分组 + 最近提交
 * - 右：选中文件的 diff + 底部提交区
 *
 * 写操作全部走 git:* IPC；UI 只负责确认与刷新，不直接拼命令行。
 *
 * 勾选语义：勾选框只表示「选中」，不立即执行 Git 操作。
 * 分组头三态全选 → 工具栏「加入暂存 / 取消暂存 / 放弃修改」
 * 一次执行整批；点文件名只加载 diff，不会改动暂存区。
 */

import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, CheckCircle2, ChevronDown, CircleDot, Cloud, GitBranch, GitBranchPlus, Minus, Plus, RefreshCw, Tag, Undo2, type LucideIcon } from "lucide-react";
import type { Project } from "@shared/types";
import type {
  GitBranchInfo,
  GitCommitSummary,
  GitFileStatus,
  GitStatusDetail,
} from "@shared/git";
import { clamp } from "@shared/math";
import { formatDateTime } from "@shared/time";
import { ipc } from "../../lib/ipc";
import { timeAgo, toMessage } from "../../lib/utils";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Select } from "../ui/Select";
import { Dialog, DialogActions } from "../ui/Dialog";
import { Field, TextInput } from "../ui/Field";
import {
  conflictedFiles,
  displayStatus,
  GIT_STATUS_META,
  stagedFiles,
  unstagedFiles,
  untrackedFiles,
} from "./gitUi";
import { Spinner } from "../ui/Spinner";
import { WorkspaceEmptyState as GitEmptyState } from "./workspaceUi";

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
type GroupKey = "conflict" | "staged" | "unstaged" | "commits";

/**
 * 勾选集合的不可变增删。
 *
 * 勾选只表示「选中」，不立即执行 Git 操作；集合内容没变化时返回原引用，
 * 避免状态刷新时触发多余渲染。
 */
function togglePath(set: Set<string>, path: string): Set<string> {
  const next = new Set(set);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** 分组全选：已全选则清空，否则补齐（保留其它分组的勾选） */
function togglePaths(set: Set<string>, paths: string[]): Set<string> {
  const allPicked = paths.length > 0 && paths.every((path) => set.has(path));
  const next = new Set(set);
  for (const path of paths) {
    if (allPicked) next.delete(path);
    else next.add(path);
  }
  return next;
}

function dropPaths(set: Set<string>, paths: string[]): Set<string> {
  const next = new Set(set);
  for (const path of paths) next.delete(path);
  return next;
}

/** 操作完成后清掉已经不存在的文件勾选 */
function intersectPaths(set: Set<string>, present: Set<string>): Set<string> {
  let changed = false;
  const next = new Set<string>();
  for (const path of set) {
    if (present.has(path)) next.add(path);
    else changed = true;
  }
  return changed ? next : set;
}

/** 冲突组没有勾选语义；复用同一个空集合，避免每次渲染新建 */
const NO_PICKS: ReadonlySet<string> = new Set<string>();

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
  /** 未跟踪文件：diff 里存的是原文件内容，统一按新增行渲染 */
  const [diffNewFile, setDiffNewFile] = useState(false);
  const [diffTruncated, setDiffTruncated] = useState(false);
  /*
   * 提交信息是根状态，每敲一个字都会重渲染整页。这里按 diff 缓存
   * 「是否有内容」，避免每次都整串 trim 复制；DiffView 则由 memo 跳过。
   */
  const hasDiff = useMemo(() => diff.trim().length > 0, [diff]);

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
  const commitInputRef = useRef<HTMLTextAreaElement>(null);

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

  /**
   * 勾选 = 选中，不立即执行 Git 操作。
   *
   * 未暂存 / 未跟踪的勾选进入 stagePicks，已暂存的勾选进入 unstagePicks；
   * 勾完后再由工具栏的「加入暂存 / 取消暂存 / 放弃修改」一次性执行，
   * 避免过去「点一个勾选框就立刻 add / reset 一个文件」的交互。
   */
  const [stagePicks, setStagePicks] = useState<Set<string>>(() => new Set());
  const [unstagePicks, setUnstagePicks] = useState<Set<string>>(
    () => new Set(),
  );

  const staged = useMemo(() => stagedFiles(status), [status]);
  const unstaged = useMemo(() => unstagedFiles(status), [status]);
  const untracked = useMemo(() => untrackedFiles(status), [status]);
  /** 未暂存与未跟踪合并展示：两者都还没进入索引，只是状态字母不同 */
  const workingFiles = useMemo(
    () => [...unstaged, ...untracked],
    [unstaged, untracked],
  );
  const conflicted = useMemo(() => conflictedFiles(status), [status]);
  const changes = status?.available ? status.files.length : 0;
  const canCommit =
    Boolean(message.trim()) &&
    staged.length > 0 &&
    !busy &&
    status?.available === true &&
    // merge 冲突解决后可以直接提交；rebase / cherry-pick 等应走「继续」
    (!status.inProgress || status.inProgress.kind === "merge");

  /**
   * 提交框与会话页输入框一致：未输入时只占一行，随内容自动增高，
   * 超过 max-h-48 后在框内滚动。
   */
  useLayoutEffect(() => {
    const textarea = commitInputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height =
      textarea.scrollHeight > 0 ? `${textarea.scrollHeight}px` : "";
  }, [message]);

  // 提交 / 暂存后文件可能从列表消失：把已经不存在的勾选剔除
  useEffect(() => {
    if (!status?.available) {
      setStagePicks((prev) => (prev.size > 0 ? new Set() : prev));
      setUnstagePicks((prev) => (prev.size > 0 ? new Set() : prev));
      return;
    }
    const stageable = new Set(
      [...unstaged, ...untracked].map((file) => file.relativePath),
    );
    const stagedPaths = new Set(staged.map((file) => file.relativePath));
    setStagePicks((prev) => intersectPaths(prev, stageable));
    setUnstagePicks((prev) => intersectPaths(prev, stagedPaths));
  }, [status, staged, unstaged, untracked]);

  // 切换工作区后旧勾选不再有意义
  useEffect(() => {
    setStagePicks(new Set());
    setUnstagePicks(new Set());
  }, [project.id]);

  // 加载选中文件的 diff；未跟踪文件没有 diff，直接读内容做「全部新增」预览
  useEffect(() => {
    if (!selected) {
      setDiff("");
      setDiffBinary(false);
      setDiffError(null);
      setDiffLoading(false);
      setDiffNewFile(false);
      setDiffTruncated(false);
      return;
    }

    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    setDiffBinary(false);
    setDiffNewFile(selected.untracked);
    setDiffTruncated(false);

    const request = selected.untracked
      ? ipc.readFile(project.id, selected.relativePath).then((result) => {
          if (cancelled) return;
          if (!result.ok) {
            setDiff("");
            setDiffError(result.error);
            return;
          }
          const file = result.file;
          // content 缺失表示图片 / PDF / 二进制文件
          if (file.content === undefined) {
            setDiff("");
            setDiffBinary(true);
            return;
          }
          setDiff(file.content);
          setDiffTruncated(Boolean(file.truncated));
        })
      : ipc
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
          });

    request
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
      setStagePicks((prev) => dropPaths(prev, paths));
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
      setUnstagePicks((prev) => dropPaths(prev, paths));
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

  const discard = async (files: GitFileStatus[]) => {
    if (files.length === 0 || busy) return;
    if (status?.inProgress) {
      toast.info("请先继续或中止当前 Git 操作");
      return;
    }

    const uniquePaths = [...new Set(files.map((file) => file.relativePath))];
    /** 新增 / 复制 / 未跟踪：放弃意味着从磁盘删除，而不是还原内容 */
    const isDelete = (file: GitFileStatus) =>
      file.untracked ||
      file.indexStatus === "added" ||
      file.indexStatus === "copied";
    const deleteOnly = files.every(isDelete);
    const hasDelete = files.some(isDelete);
    const target =
      uniquePaths.length === 1
        ? (uniquePaths[0].split("/").pop() ?? uniquePaths[0])
        : `${uniquePaths.length} 个文件`;

    const confirmed = await confirmDialog({
      title: deleteOnly ? `删除「${target}」？` : `放弃「${target}」的修改？`,
      message: deleteOnly
        ? "文件会从磁盘删除，无法恢复。"
        : hasDelete
          ? "选中的未跟踪文件会从磁盘删除，其余修改会还原到最近一次提交（HEAD）的内容。无法恢复。"
          : "工作区修改会还原到最近一次提交（HEAD）的内容，无法恢复。",
      confirmLabel: deleteOnly ? "删除" : hasDelete ? "放弃并删除" : "放弃",
      tone: "danger",
    });
    if (!confirmed) return;

    setBusy("discard");
    try {
      const result = await ipc.discardGitPaths(project.id, uniquePaths);
      if (!result.ok) {
        toast.error(result.error ?? "放弃失败", 8000);
        setSelected(null);
        onRefresh();
        return;
      }
      toast.success(deleteOnly ? "已删除文件" : "已放弃修改");
      setSelected(null);
      setMessage("");
      setCommitError(null);
      setCommitOutput(null);
      setStagePicks(new Set());
      setUnstagePicks(new Set());
      onAfterMutation();
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setBusy(null);
    }
  };

  const continueOperation = async () => {
    if (busy || !status?.inProgress) return;
    setBusy("continue");
    try {
      const result = await ipc.continueGitOperation(project.id);
      if (!result.ok) {
        toast.error(result.error ?? "继续操作失败", 8000);
        // rebase / cherry-pick 可能推进到下一个冲突：刷新让横幅与文件列表跟上
        setSelected(null);
        onAfterMutation();
        return;
      }
      toast.success("已继续 Git 操作");
      setSelected(null);
      setMessage("");
      setCommitError(null);
      setCommitOutput(null);
      setStagePicks(new Set());
      setUnstagePicks(new Set());
      onAfterMutation();
    } catch (err) {
      toast.error(toMessage(err), 6000);
    } finally {
      setBusy(null);
    }
  };

  const abortOperation = async () => {
    if (busy || !status?.inProgress) return;
    const isBisect = status.inProgress.kind === "bisect";
    const confirmed = await confirmDialog({
      title: isBisect ? "结束二分查找？" : "中止当前 Git 操作？",
      message: isBisect
        ? "会回到二分查找开始前的分支。"
        : "已解决的冲突与暂存状态会回退到操作开始前，无法恢复。",
      confirmLabel: isBisect ? "结束" : "中止",
      tone: "danger",
    });
    if (!confirmed) return;

    setBusy("abort");
    try {
      const result = await ipc.abortGitOperation(project.id);
      if (!result.ok) {
        toast.error(result.error ?? "中止操作失败", 8000);
        setSelected(null);
        onAfterMutation();
        return;
      }
      toast.success(isBisect ? "已结束二分查找" : "已中止 Git 操作");
      setSelected(null);
      setMessage("");
      setCommitError(null);
      setCommitOutput(null);
      setStagePicks(new Set());
      setUnstagePicks(new Set());
      onAfterMutation();
    } catch (err) {
      toast.error(toMessage(err), 6000);
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

  const push = async () => {
    if (!status?.branch || status.detached || busy) return;
    setBusy("push");
    try {
      const result = await ipc.pushGitBranch(project.id, status.branch);
      if (!result.ok) {
        toast.error(result.error ?? "推送失败", 6000);
        return;
      }
      toast.success("已推送到远端");
      onRefresh();
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setBusy(null);
    }
  };

  const pull = async () => {
    if (busy) return;
    setBusy("pull");
    try {
      const result = await ipc.pullGitBranch(project.id);
      if (!result.ok) {
        toast.error(result.error ?? "拉取失败", 6000);
        return;
      }
      toast.success("已拉取远端更新");
      setSelected(null);
      onAfterMutation();
    } catch (err) {
      toast.error(toMessage(err), 5000);
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
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (!status.available) {
    const gitMissing =
      Boolean(status.error?.includes("未检测到 git")) ||
      Boolean(status.error?.toLowerCase().includes("not found"));
    return (
      <div className="h-full">
        <GitEmptyState
          icon={<GitBranch className="h-5 w-5" />}
          title={gitMissing ? "未检测到 Git" : "该工作区还不是 Git 仓库"}
          description={
            status.error ?? "初始化后可以在这里查看变更、切换分支并提交。"
          }
        >
          {!gitMissing && (
            <Button
              variant="primary"
              className="mt-1"
              size="sm"
              loading={busy === "init"}
              onClick={() => void init()}
            >
              初始化 Git 仓库
            </Button>
          )}
        </GitEmptyState>
      </div>
    );
  }

  const branchOptions = branches.map((branch) => ({
    value: branch.name,
    label: branch.current ? `${branch.name}（当前）` : branch.name,
  }));

  /** 当前分支是否已有 upstream；没有时「推送」会顺带建立跟踪 */
  const hasUpstream = Boolean(
    branches.find((branch) => branch.current)?.upstream,
  );
  const canPush =
    status.hasHead &&
    !status.detached &&
    Boolean(status.branch) &&
    !busy &&
    !status.inProgress &&
    (status.ahead > 0 || !hasUpstream);
  /** 分支列表未加载出来时不做判断，交给主进程给出明确错误 */
  const canPull =
    status.hasHead &&
    !status.detached &&
    !busy &&
    !status.inProgress &&
    (branches.length === 0 || hasUpstream);

  /**
   * 放弃只作用于工作区：未跟踪，或索引里没有内容的纯未暂存文件。
   * 已暂存（包括部分暂存）的文件必须先取消暂存，
   * 否则一次操作会把暂存内容和工作区修改一起抹掉。
   */
  const discardablePicks = new Set(
    [...stagePicks].filter((path) => {
      const file = status.files.find((item) => item.relativePath === path);
      return file !== undefined && file.indexStatus === null;
    }),
  );
  const discardPicked = () => {
    const files = status.files.filter((file) =>
      discardablePicks.has(file.relativePath),
    );
    void discard(files);
  };

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
      {/* 进行中的多步操作：优先于一切其它操作，先让用户收尾 */}
      {status.inProgress && (
        <div
          className="ws-op"
          data-kind={status.inProgress.kind}
          role="status"
          aria-live="polite"
        >
          <span className="ws-op-icon">
            <AlertTriangle className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="ws-op-title">
              {status.inProgress.label}
              {status.inProgress.step
                ? ` · ${status.inProgress.step}`
                : ""}
            </p>
            <p className="ws-op-desc">
              {status.inProgress.kind === "bisect"
                ? "请在终端标记 good / bad，或中止回到起点。"
                : "解决冲突后继续，或中止这次操作。"}
            </p>
          </div>
          <div className="ws-op-actions">
            {status.inProgress.canContinue && (
              <button
                type="button"
                className="ws-op-button"
                disabled={Boolean(busy)}
                onClick={() => void continueOperation()}
              >
                {busy === "continue" ? (
                  <Spinner className="h-3 w-3" />
                ) : null}
                继续
              </button>
            )}
            <button
              type="button"
              className="ws-op-button ws-op-button-danger"
              disabled={Boolean(busy)}
              onClick={() => void abortOperation()}
            >
              {busy === "abort" ? <Spinner className="h-3 w-3" /> : null}
              {status.inProgress.kind === "bisect" ? "结束" : "中止"}
            </button>
          </div>
        </div>
      )}

      {/* 顶栏：分支 / 批量操作 */}
      <div className="ws-toolbar">
        <div className="ws-branch">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-accent" />
          {branchOptions.length > 0 ? (
            <Select
              value={status.branch ?? ""}
              onChange={requestCheckout}
              options={branchOptions}
              disabled={Boolean(busy) || Boolean(status.inProgress)}
              className="ws-branch-name max-w-44 text-text-secondary"
              minMenuWidth={200}
              aria-label="切换分支"
              title="切换分支"
            />
          ) : (
            <span className="ws-branch-name text-text-muted">尚无分支</span>
          )}
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="ws-branch-meta">
              {status.ahead > 0 && <span>↑{status.ahead}</span>}
              {status.behind > 0 && <span>↓{status.behind}</span>}
            </span>
          )}
        </div>

        {status.detached && (
          <span className="ws-warning">
            <AlertTriangle className="h-3 w-3" />
            detached HEAD
          </span>
        )}

        <div className="ws-toolbar-divider" />

        {/* 勾选后的批量入口：只在有选中时出现，点一次执行整批 */}
        {(stagePicks.size > 0 ||
          unstagePicks.size > 0 ||
          discardablePicks.size > 0) && (
          <>
            <div className="ws-toolbar-group">
              {stagePicks.size > 0 && (
                <button
                  type="button"
                  className="ws-tool ws-tool-accent"
                  onClick={() => void stage([...stagePicks])}
                  disabled={Boolean(busy)}
                  title={`将选中的 ${stagePicks.size} 个文件加入暂存`}
                >
                  <Plus className="h-3.5 w-3.5" />
                  加入暂存
                  <span className="ws-tool-count">{stagePicks.size}</span>
                </button>
              )}
              {unstagePicks.size > 0 && (
                <button
                  type="button"
                  className="ws-tool ws-tool-accent"
                  onClick={() => void unstage([...unstagePicks])}
                  disabled={Boolean(busy)}
                  title={`将选中的 ${unstagePicks.size} 个文件取消暂存`}
                >
                  <Minus className="h-3.5 w-3.5" />
                  取消暂存
                  <span className="ws-tool-count">{unstagePicks.size}</span>
                </button>
              )}
              {discardablePicks.size > 0 && (
                <button
                  type="button"
                  className="ws-tool ws-tool-danger"
                  onClick={discardPicked}
                  disabled={Boolean(busy) || Boolean(status.inProgress)}
                  title={`放弃选中的 ${discardablePicks.size} 个未暂存 / 未跟踪文件的修改（已暂存的文件请先取消暂存）`}
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  放弃修改
                </button>
              )}
            </div>
            <div className="ws-toolbar-divider" />
          </>
        )}

        <div className="ws-toolbar-group">
          <button
            type="button"
            className="ws-tool"
            onClick={() => setNewBranchOpen(true)}
            disabled={Boolean(busy) || Boolean(status.inProgress)}
            title="基于当前 HEAD 创建并切换"
          >
            <GitBranchPlus className="h-3.5 w-3.5" />
            新建分支
          </button>
          <button
            type="button"
            className="ws-tool"
            onClick={() => void pull()}
            disabled={!canPull}
            title={
              hasUpstream || branches.length === 0
                ? "拉取远端更新（仅 fast-forward）"
                : "当前分支没有 upstream，请先推送一次"
            }
          >
            {busy === "pull" ? (
              <Spinner className="h-3 w-3" />
            ) : (
              <ArrowDown className="h-3.5 w-3.5" />
            )}
            拉取
          </button>
          <button
            type="button"
            className="ws-tool"
            onClick={() => void push()}
            disabled={!canPush}
            title={
              hasUpstream
                ? "推送本地提交到远端"
                : "首次推送并建立 upstream 跟踪"
            }
          >
            {busy === "push" ? (
              <Spinner className="h-3 w-3" />
            ) : (
              <ArrowUp className="h-3.5 w-3.5" />
            )}
            推送
          </button>
        </div>

        {/* 全仓库操作固定在右侧 */}
        <div className="ws-toolbar-group ml-auto">
          <button
            type="button"
            className="ws-tool"
            onClick={() =>
              void stage(
                [...unstaged, ...untracked].map((file) => file.relativePath),
              )
            }
            disabled={Boolean(busy) || unstaged.length + untracked.length === 0}
            title="将所有未暂存与未跟踪文件加入暂存"
          >
            <Plus className="h-3.5 w-3.5" />
            全部加入暂存
          </button>
          <button
            type="button"
            className="ws-tool"
            onClick={() =>
              void unstage(staged.map((file) => file.relativePath))
            }
            disabled={Boolean(busy) || staged.length === 0}
            title="取消暂存所有文件"
          >
            <Minus className="h-3.5 w-3.5" />
            全部取消暂存
          </button>
        </div>
        <div className="ws-toolbar-divider" />
        <IconButton
          icon={
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
          }
          label="刷新 Git 状态"
          size="xs"
          tone="muted"
          disabled={loading}
          onClick={onRefresh}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：变更 + 历史 */}
        <aside className="flex w-[340px] shrink-0 flex-col border-r border-border">
          {/* 变更列表：占剩余空间，独立滚动 */}
          <div className="ws-changes">
            {changes === 0 ? (
              <div className="ws-empty">
                <span className="ws-empty-icon">
                  <CheckCircle2 className="h-5 w-5 text-success" />
                </span>
                <p className="ws-empty-title">工作区干净</p>
                <p className="ws-empty-desc">
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
                    picked={NO_PICKS}
                    onTogglePick={() => undefined}
                    onTogglePickAll={() => undefined}
                    onResolve={(file) => void stage([file.relativePath])}
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
                    onSelect={setSelected}
                    picked={unstagePicks}
                    onTogglePick={(file) =>
                      setUnstagePicks((prev) =>
                        togglePath(prev, file.relativePath),
                      )
                    }
                    onTogglePickAll={() =>
                      setUnstagePicks((prev) =>
                        togglePaths(
                          prev,
                          staged.map((file) => file.relativePath),
                        ),
                      )
                    }
                  />
                )}
                {workingFiles.length > 0 && (
                  <ChangeGroup
                    title="未暂存"
                    files={workingFiles}
                    kind="unstaged"
                    selected={selected}
                    busy={busy}
                    collapsed={isCollapsed("unstaged")}
                    onToggleCollapsed={() => toggleGroup("unstaged")}
                    onSelect={setSelected}
                    picked={stagePicks}
                    onTogglePick={(file) =>
                      setStagePicks((prev) =>
                        togglePath(prev, file.relativePath),
                      )
                    }
                    onTogglePickAll={() =>
                      setStagePicks((prev) =>
                        togglePaths(
                          prev,
                          workingFiles.map((file) => file.relativePath),
                        ),
                      )
                    }
                  />
                )}
              </div>
            )}

          </div>

          {/* 最近提交：展开时固定为父高度的 1/3，折叠后只留标题 */}
          <section
            className={`ws-commits ${isCollapsed("commits") ? "" : "h-1/3"}`}
          >
            <button
              type="button"
              aria-expanded={!isCollapsed("commits")}
              onClick={() => toggleGroup("commits")}
              className="ws-group-head shrink-0"
            >
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
                  isCollapsed("commits") ? "-rotate-90" : ""
                }`}
              />
              <span className="ws-group-title">最近提交</span>
              <span className="ws-counter">{commits.length}</span>
            </button>
            <div
              className={`min-h-0 flex-1 overflow-y-auto px-2 pb-2 ${
                isCollapsed("commits") ? "hidden" : ""
              }`}
            >
              {commits.length === 0 ? (
                <p className="my-0 px-1 py-2 ui-type-sub text-text-muted">
                  {status.hasHead ? "还没有提交记录" : "仓库还没有第一次提交"}
                </p>
              ) : (
                <CommitGraph
                  commits={commits}
                  ahead={status.ahead}
                  branch={status.branch}
                  branches={branches}
                />
              )}
            </div>
          </section>
        </aside>

        {/* 右：diff + 提交 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="ws-diff-head">
              <span
                className="ws-diff-path"
                title={selected?.relativePath}
              >
                {selected?.relativePath ?? "选择左侧变更文件查看 diff"}
              </span>
              {selected && !selectedDeleted && (
                <button
                  type="button"
                  className="ws-tool"
                  onClick={() => onOpenFile(selected.relativePath)}
                >
                  打开文件
                </button>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {!selected ? (
                changes === 0 ? (
                  <GitEmptyState
                    icon={<CheckCircle2 className="h-5 w-5 text-success" />}
                    title="没有未提交变更"
                    description="工作区是干净的。可以切换分支，或从左侧查看最近的提交记录。"
                  />
                ) : (
                  <GitEmptyState
                    icon={<GitBranch className="h-5 w-5" />}
                    title="选择一个变更文件"
                    description="点击左侧文件查看 diff；勾选文件可以加入暂存、取消暂存或放弃修改。"
                  />
                )
              ) : diffLoading ? (
                <div className="flex h-full items-center justify-center text-text-muted">
                  <Spinner className="h-5 w-5" />
                </div>
              ) : diffError ? (
                <div className="m-3 rounded-md border border-error/25 bg-error-bg px-3 py-2 ui-type-note text-error">
                  {diffError}
                </div>
              ) : diffBinary ? (
                <GitEmptyState
                  icon={<AlertTriangle className="h-5 w-5 text-agent-amber" />}
                  title="二进制文件"
                  description="无法以文本方式显示 diff，请用系统程序打开查看。"
                />
              ) : !hasDiff ? (
                <GitEmptyState
                  icon={<GitBranch className="h-5 w-5" />}
                  title="没有可显示的 diff"
                  description="文件可能已删除或内容未变化。"
                />
              ) : (
                <DiffView
                  diff={diff}
                  newFile={diffNewFile}
                  truncated={diffTruncated}
                />
              )}
            </div>
          </div>

          {/* 提交区：与会话页输入框共用同一套外观（纸面 / 描边 / 聚焦光晕） */}
          {changes > 0 && (
            <div
              ref={commitBoxRef}
              className="border-t border-border bg-bg px-5 py-3"
            >
              <div className="mx-auto w-full max-w-[var(--c-layout-content)]">
                <div className="rounded-input border border-border/80 bg-input-bg px-3 py-2 shadow-[var(--c-shadow-sm)] transition-[border-color,box-shadow] focus-within:border-accent/40 focus-within:shadow-[0_0_0_3px_var(--c-accent-soft)]">
                  <textarea
                    ref={commitInputRef}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        (event.metaKey || event.ctrlKey) &&
                        event.key === "Enter"
                      ) {
                        event.preventDefault();
                        void commit();
                      }
                    }}
                    placeholder="描述这次变更…"
                    rows={1}
                    className="max-h-48 min-h-[40px] w-full resize-none bg-transparent px-1.5 py-1 ui-type-item leading-relaxed text-text placeholder-text-muted outline-none"
                  />

                  {checkoutAfterCommit && (
                    <p className="my-1 flex items-center gap-2 px-1.5 ui-type-sub text-agent-amber">
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
                    <div className="my-1 rounded-md border border-error/25 bg-error-bg px-3 py-2 ui-type-note text-error">
                      <p>{commitError}</p>
                      {commitOutput && (
                        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap ui-type-code-sm opacity-80">
                          {commitOutput}
                        </pre>
                      )}
                    </div>
                  )}

                  <div className="mt-0 flex items-center justify-between gap-3 border-t border-border/60 pt-1">
                    <span className="min-w-0 truncate px-1.5 ui-type-sub text-text-muted">
                      {staged.length === 0
                        ? "先在左侧勾选要提交的文件"
                        : message.trim()
                          ? `将提交 ${staged.length} 个文件`
                          : "填写提交信息后即可提交"}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span
                        className="ui-type-sub text-text-muted"
                        title="Ctrl / ⌘ + Enter 提交"
                      >
                        Ctrl/⌘ + ↵
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
                </div>
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
        <p className="ui-type-note leading-relaxed text-text-secondary">
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
  onSelect,
  picked,
  onTogglePick,
  onTogglePickAll,
  onResolve,
}: {
  title: string;
  files: GitFileStatus[];
  kind: "staged" | "unstaged" | "conflict";
  selected: SelectedFile | null;
  busy: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (file: SelectedFile) => void;
  /** 本分组的勾选集合；勾选只表示选中，不会立即执行 Git 操作 */
  picked: ReadonlySet<string>;
  onTogglePick: (file: GitFileStatus) => void;
  /** 分组级全选 / 取消全选；冲突组不传 */
  onTogglePickAll?: () => void;
  /** 冲突组行尾的「标记已解决」入口（git add） */
  onResolve?: (file: GitFileStatus) => void;
}) {
  const pickedCount = files.reduce(
    (count, file) => count + (picked.has(file.relativePath) ? 1 : 0),
    0,
  );
  const pickState =
    pickedCount === 0 ? "none" : pickedCount === files.length ? "all" : "some";

  return (
    <div className="ws-group">
      <div className="ws-group-row">
        {kind !== "conflict" && (
          <button
            type="button"
            role="checkbox"
            aria-checked={
              pickState === "all"
                ? true
                : pickState === "some"
                  ? "mixed"
                  : false
            }
            aria-label={pickState === "all" ? "取消选择此分组" : "选择此分组"}
            className="ws-group-check"
            data-state={pickState}
            disabled={Boolean(busy)}
            onClick={onTogglePickAll}
            title={pickState === "all" ? "取消选择此分组" : "选择此分组"}
          >
            {pickState === "all" ? (
              <Check className="h-2.5 w-2.5" strokeWidth={3.2} />
            ) : pickState === "some" ? (
              <Minus className="h-2.5 w-2.5" strokeWidth={3.2} />
            ) : null}
          </button>
        )}
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
          className="ws-group-head"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
              collapsed ? "-rotate-90" : ""
            }`}
          />
          <span
            className="ws-group-title"
            data-tone={kind === "conflict" ? "danger" : undefined}
          >
            {title}
          </span>
          <span className="ws-counter">{files.length}</span>
        </button>
      </div>

      {/* 分组本身不滚动：所有变更共用一个滚动容器（.ws-changes） */}
      <div className={`space-y-0.5 ${collapsed ? "hidden" : ""}`}>
        {files.map((file) => {
          const stagedFlag = kind === "staged";
          const untrackedFlag = file.untracked;
          const active =
            selected?.relativePath === file.relativePath &&
            selected?.staged === stagedFlag &&
            selected?.untracked === untrackedFlag;
          const status = displayStatus(file);
          const meta = GIT_STATUS_META[status];
          const name =
            file.relativePath.split("/").pop() ?? file.relativePath;
          const parent = parentPath(file.relativePath);
          const isPicked = picked.has(file.relativePath);

          return (
            <div
              key={`${kind}:${file.relativePath}`}
              className="ws-file ui-cv-row"
              data-active={active}
            >
              {kind !== "conflict" ? (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isPicked}
                  disabled={Boolean(busy)}
                  onClick={() => onTogglePick(file)}
                  title={isPicked ? "取消选择" : "选择此文件"}
                  aria-label={isPicked ? "取消选择" : "选择此文件"}
                  data-checked={isPicked}
                  className="ws-check disabled:opacity-40"
                >
                  <Check className="h-2.5 w-2.5" strokeWidth={3.2} />
                </button>
              ) : (
                <span className="grid h-[14px] w-[14px] shrink-0 place-items-center text-error">
                  <AlertTriangle className="h-3 w-3" />
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
                <span className="ws-file-name">{name}</span>
                {parent && <span className="ws-file-path">{parent}</span>}
                <span
                  className="ws-status ml-auto"
                  data-status={status}
                  title={meta.text}
                >
                  {meta.label}
                </span>
              </button>
              {kind === "conflict" && (
                <button
                  type="button"
                  className="ws-file-resolve"
                  disabled={Boolean(busy)}
                  onClick={() => onResolve?.(file)}
                  title="标记为已解决（git add）"
                  aria-label="标记为已解决"
                >
                  <Check className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// 最近提交：Git Graph 风格
// ============================================================================

type CommitRefKind = "head" | "branch" | "remote" | "tag";

interface CommitRefBadge {
  label: string;
  kind: CommitRefKind;
}

const COMMIT_REF_BADGE: Record<CommitRefKind, { icon: LucideIcon }> = {
  head: { icon: CircleDot },
  branch: { icon: GitBranch },
  remote: { icon: Cloud },
  tag: { icon: Tag },
};

/** 竖线颜色跟着提交段走：未推送段用主色，已推送段用紫色 */
type GraphTone = "outgoing" | "pushed";

const GRAPH_TONE: Record<
  GraphTone,
  { line: string; dot: string; ring: string }
> = {
  outgoing: { line: "bg-accent", dot: "bg-accent", ring: "border-accent" },
  pushed: {
    line: "bg-agent-violet",
    dot: "bg-agent-violet",
    ring: "border-agent-violet",
  },
};

/** 提交行的悬浮信息卡：定位用视口坐标，经 portal 渲染，避免被列表裁切 */
interface CommitHoverState {
  commit: GitCommitSummary;
  tone: GraphTone;
  top: number;
  left: number;
}

function CommitGraph({
  commits,
  ahead,
  branch,
  branches,
}: {
  commits: GitCommitSummary[];
  /** 相对 upstream 领先的提交数；窗口内截断使用 */
  ahead: number;
  branch: string | null;
  branches: GitBranchInfo[];
}) {
  const localBranches = new Set(branches.map((item) => item.name));
  const outgoing = clamp(ahead, 0, commits.length);
  const showOutgoing = outgoing > 0 && Boolean(branch);
  const rowCount = commits.length + (showOutgoing ? 1 : 0);

  const [hovered, setHovered] = useState<CommitHoverState | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHide = () => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  /** 留一点延迟：鼠标从提交行移进卡片时不会被立刻收起 */
  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => setHovered(null), 140);
  };

  useEffect(() => {
    if (!hovered) return;
    const dismiss = () => setHovered(null);
    // 列表滚动 / 窗口缩放后固定定位会脱节，直接收起
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [hovered]);

  useEffect(
    () => () => {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );

  const showCard = (
    event: MouseEvent<HTMLDivElement>,
    commit: GitCommitSummary,
    tone: GraphTone,
  ) => {
    cancelHide();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 380;
    const height = 240;
    const gap = 12;
    let left = rect.right + gap;
    // 右侧放不下时翻到左边；顶部 / 底部都留出边距
    if (left + width > window.innerWidth - 12) {
      left = Math.max(12, rect.left - width - gap);
    }
    const top = Math.max(
      12,
      Math.min(rect.top - 8, window.innerHeight - height - 12),
    );
    setHovered({ commit, tone, top, left });
  };

  return (
    <div>
      {/* 未推送的提交聚合在「传出的更改」下，与已推送段用颜色区分 */}
      {showOutgoing && (
        <div className="relative flex h-7 items-center gap-1.5 pr-1">
          <GraphRail
            tone="outgoing"
            size="small"
            isFirst
            isLast={rowCount === 1}
          />
          <span className="shrink-0 ui-type-sub font-medium text-text-secondary">
            传出的更改
          </span>
          <span className="min-w-0 truncate ui-type-sub text-text-muted">
            {branch}
          </span>
        </div>
      )}

      {commits.map((commit, index) => {
        const isHead = index === 0;
        const tone: GraphTone = index < outgoing ? "outgoing" : "pushed";
        const badges = parseCommitRefs(commit.refs, localBranches);
        const rest = badges.slice(2);

        return (
          <div
            key={commit.hash}
            className="ws-commit-item ui-cv-row"
            data-head={isHead}
            onMouseEnter={(event) => showCard(event, commit, tone)}
            onMouseLeave={scheduleHide}
          >
            <GraphRail
              tone={tone}
              head={isHead}
              isFirst={index === 0 && !showOutgoing}
              isLast={index === commits.length - 1}
            />
            <span className="ws-commit-subject">{commit.subject}</span>
            {badges.slice(0, 2).map((badge) => (
              <CommitRefChip
                key={`${badge.kind}:${badge.label}`}
                badge={badge}
              />
            ))}
            {rest.length > 0 && (
              <span className="ws-counter">+{rest.length}</span>
            )}
          </div>
        );
      })}

      {hovered &&
        createPortal(
          <div
            className="ws-commit-card ui-dropdown-in"
            role="tooltip"
            style={{ top: hovered.top, left: hovered.left }}
            onMouseEnter={cancelHide}
            onMouseLeave={scheduleHide}
          >
            <div className="ws-commit-card-head">
              <span className="ws-commit-card-kicker" data-tone={hovered.tone}>
                <span className="ws-commit-card-dot" />
                {hovered.tone === "outgoing" ? "未推送" : "已推送"}
              </span>
            </div>
            <p className="ws-commit-card-subject">{hovered.commit.subject}</p>
            <div className="ws-commit-card-rows">
              <span className="ws-commit-card-label">提交人：</span>
              <span className="ws-commit-card-value">
                {hovered.commit.author || "—"}
              </span>
              <span className="ws-commit-card-label">时间：</span>
              <span className="ws-commit-card-value">
                {timeAgo(hovered.commit.date)}
                <span className="ws-commit-card-abs">
                  {" · "}
                  {formatDateTime(hovered.commit.date)}
                </span>
              </span>
              <span className="ws-commit-card-label">哈希：</span>
              <span className="ws-commit-card-value ws-commit-card-hash-value">
                {hovered.commit.hash}
              </span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** 左侧竖线 + 圆点；首尾行把线裁到圆点，避免超出提交范围 */
function GraphRail({
  tone,
  head = false,
  isFirst = false,
  isLast = false,
  size = "normal",
}: {
  tone: GraphTone;
  /** HEAD 用空心圆点 */
  head?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  size?: "normal" | "small";
}) {
  const { line, dot, ring } = GRAPH_TONE[tone];
  const drawLine = !(isFirst && isLast);

  return (
    <span className="relative flex h-full w-5 shrink-0 items-center justify-center">
      {drawLine && (
        <span
          aria-hidden
          className={`absolute left-1/2 w-px -translate-x-1/2 ${line} ${
            isFirst
              ? "top-1/2 bottom-0"
              : isLast
                ? "top-0 bottom-1/2"
                : "inset-y-0"
          }`}
        />
      )}
      {head ? (
        <span
          className={`relative h-[13px] w-[13px] rounded-full border-2 bg-surface ${ring}`}
        />
      ) : (
        <span
          className={`relative rounded-full ${dot} ${
            size === "small" ? "h-[7px] w-[7px]" : "h-[11px] w-[11px]"
          }`}
        />
      )}
    </span>
  );
}

function CommitRefChip({ badge }: { badge: CommitRefBadge }) {
  const { icon: Icon } = COMMIT_REF_BADGE[badge.kind];

  return (
    <span className="ws-ref" data-kind={badge.kind}>
      <Icon className="h-3 w-3" />
      <span className="max-w-[92px] truncate">{badge.label}</span>
    </span>
  );
}

/** %D 的引用串 → 徽标；本地分支表用来区分「远端跟踪分支」和「带斜杠的本地分支」 */
function parseCommitRefs(
  refs: string[],
  localBranches: Set<string>,
): CommitRefBadge[] {
  const badges: CommitRefBadge[] = [];

  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;

    if (ref.startsWith("HEAD -> ")) {
      badges.push({ label: ref.slice("HEAD -> ".length), kind: "head" });
      continue;
    }
    if (ref === "HEAD") {
      badges.push({ label: "HEAD", kind: "head" });
      continue;
    }
    if (ref.startsWith("tag: ")) {
      badges.push({ label: ref.slice("tag: ".length), kind: "tag" });
      continue;
    }
    // origin/HEAD 只是远端默认分支的别名，不单独展示
    if (ref.endsWith("/HEAD")) continue;

    const kind: CommitRefKind =
      localBranches.has(ref) || !ref.includes("/") ? "branch" : "remote";
    // 远端分支只显示分支名：云图标已经表明它来自远端
    const label =
      kind === "remote" ? ref.slice(ref.indexOf("/") + 1) : ref;

    badges.push({ label, kind });
  }

  return badges;
}

// ============================================================================
// Diff
// ============================================================================

/**
 * memo：diff 只随选中文件变化，但父组件（提交信息输入）每敲一个字都会
 * 重渲染。没有 memo 时，几千行 diff 的 split/filter 与逐行 VDOM diff
 * 会在每次击键时重跑，输入明显发涩。
 */
const DiffView = memo(function DiffView({
  diff,
  newFile = false,
  truncated = false,
}: {
  diff: string;
  /** 未跟踪文件：整份内容都按新增行渲染，不解析 diff 头 */
  newFile?: boolean;
  /** 文件读取被截断（仅未跟踪预览会出现） */
  truncated?: boolean;
}) {
  const lines = diff.split(/\r?\n/);
  // 新文件以换行结尾时会多出一个空元素，它不是实际的一行
  if (newFile && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const added = newFile
    ? lines.length
    : lines.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .length;
  const removed = newFile
    ? 0
    : lines.filter((line) => line.startsWith("-") && !line.startsWith("---"))
        .length;

  /** 当前 hunk 的旧 / 新行号；遇到 hunk 头时重置 */
  let oldNo: number | null = null;
  let newNo: number | null = null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1.5">
        <span className="ws-diff-stat ws-diff-add">+{added}</span>
        <span className="ws-diff-stat ws-diff-del">-{removed}</span>
        <span className="ml-auto ui-type-sub ui-num text-text-muted">
          {lines.length} 行
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <pre className="ws-diff-body min-w-max py-2">
          {lines.map((line, index) => {
            if (newFile) {
              return (
                <div key={index} className="ws-diff-line" data-kind="add">
                  <span className="ws-diff-gutter" aria-hidden>
                    {index + 1}
                  </span>
                  <span className="ws-diff-code">{line || " "}</span>
                </div>
              );
            }

            let kind = "context";
            let oldLine: number | null = null;
            let newLine: number | null = null;

            if (
              line.startsWith("diff --git") ||
              line.startsWith("index ") ||
              line.startsWith("---") ||
              line.startsWith("+++") ||
              line.startsWith("\\")
            ) {
              kind = "meta";
            } else if (line.startsWith("@@")) {
              const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
              if (match) {
                oldNo = Number(match[1]);
                newNo = Number(match[2]);
              }
              kind = "hunk";
            } else if (line.startsWith("+")) {
              kind = "add";
              newLine = newNo;
              if (newNo !== null) newNo += 1;
            } else if (line.startsWith("-")) {
              kind = "del";
              oldLine = oldNo;
              if (oldNo !== null) oldNo += 1;
            } else {
              oldLine = oldNo;
              newLine = newNo;
              if (oldNo !== null) oldNo += 1;
              if (newNo !== null) newNo += 1;
            }

            return (
              <div key={index} className="ws-diff-line" data-kind={kind}>
                <span className="ws-diff-gutter" aria-hidden>
                  {/* 单列行号：优先新文件行号；删除行没有新行号，退回旧行号 */}
                  {newLine ?? oldLine ?? ""}
                </span>
                <span className="ws-diff-code">{line || " "}</span>
              </div>
            );
          })}
        </pre>
        {truncated && (
          <p className="m-0 border-t border-border px-3 py-2 ui-type-sub text-text-muted">
            文件过大，仅显示前一部分。
          </p>
        )}
      </div>
    </div>
  );
});

function parentPath(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index >= 0 ? relativePath.slice(0, index) : "";
}
