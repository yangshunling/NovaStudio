/**
 * 工作区控制台
 *
 * 右侧工作台：头部（工作区名 / 分支 / 动作） + 两个 Tab：文件 / Git。
 * 两个 Tab 常驻挂载，切换不丢文件预览标签和 Git 提交草稿。
 */

import { useEffect, useRef, useState } from "react";
import {
  Copy,
  FolderKanban,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import type { Project } from "@shared/types";
import type {
  GitBranchInfo,
  GitCommitSummary,
  GitStatusDetail,
} from "@shared/git";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { PageHeader } from "../ui/Page";
import { SegmentedTabs } from "../ui/SegmentedTabs";
import {
  MENU_WIDTH,
  MenuItem,
  MenuPanel,
  MenuSeparator,
} from "../ui/Menu";
import { FilesTab, type FilesRequest } from "./FilesTab";
import { GitTab } from "./GitTab";
import { changeCount } from "./gitUi";

export type WorkspaceTab = "files" | "git";

export interface WorkspaceConsoleProps {
  project: Project;
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  onOpenFolder: () => void;
  onOpenTerminal: () => void;
  onCopyPath: () => void;
  onDelete: () => void;
  onBrowseFilesInChat: () => void;
}

export function WorkspaceConsole({
  project,
  tab,
  onTabChange,
  onOpenFolder,
  onOpenTerminal,
  onCopyPath,
  onDelete,
  onBrowseFilesInChat,
}: WorkspaceConsoleProps) {
  const [git, setGit] = useState<GitStatusDetail | null>(null);
  const [gitLoading, setGitLoading] = useState(true);
  const [gitTick, setGitTick] = useState(0);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);

  /** 分支切换 / 初始化会改变文件内容：变化时让文件页重新加载目录树 */
  const [revision, setRevision] = useState(0);

  const [filesRequest, setFilesRequest] = useState<FilesRequest | null>(null);
  const requestNonce = useRef(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setGitLoading(true);

    ipc
      .getGitStatusDetail(project.id)
      .then(async (status) => {
        if (cancelled) return;
        setGit(status);

        if (!status.available) {
          setBranches([]);
          setCommits([]);
          return;
        }

        const [branchList, log] = await Promise.all([
          ipc.listGitBranches(project.id),
          ipc.listGitLog(project.id, 20),
        ]);
        if (cancelled) return;
        setBranches(branchList);
        setCommits(log);
      })
      .catch((err) => {
        if (cancelled) return;
        setGit({
          available: false,
          repoRoot: null,
          branch: null,
          detached: false,
          ahead: 0,
          behind: 0,
          hasHead: false,
          files: [],
          error: toMessage(err),
        });
      })
      .finally(() => {
        if (!cancelled) setGitLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [project.id, gitTick]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const changes = changeCount(git);

  const openFiles = (request: Omit<FilesRequest, "nonce">) => {
    requestNonce.current += 1;
    setFilesRequest({ ...request, nonce: requestNonce.current });
    onTabChange("files");
  };

  const refreshGit = () => {
    setGitTick((value) => value + 1);
  };

  /** 分支切换 / 初始化：文件内容已变，文件页要重新加载目录树 */
  const afterWorkspaceMutation = () => {
    setGitTick((value) => value + 1);
    setRevision((value) => value + 1);
  };

  const openMenu = (event: React.MouseEvent) => {
    event.stopPropagation();
    setMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 180)),
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        icon={<FolderKanban className="h-4 w-4" />}
        title={project.name}
        subtitle={project.cwd}
        actions={
          <>
            {git?.available && (
              <button
                type="button"
                onClick={() => onTabChange("git")}
                title="查看 Git 状态 / 切换分支"
                className="flex h-8 max-w-56 items-center gap-1.5 rounded-full border border-border/70 bg-surface-2/50 px-2.5 text-meta text-text-secondary transition-colors hover:border-accent/35 hover:text-text"
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="min-w-0 truncate font-mono">
                  {git.branch ?? "HEAD"}
                </span>
                {changes > 0 && (
                  <span className="shrink-0 rounded-full bg-agent-amber/10 px-1.5 font-mono text-caption text-agent-amber">
                    {changes}
                  </span>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={onOpenTerminal}
              title="在此工作区打开终端"
              aria-label="打开终端"
              className="ui-btn-round ui-icon-action flex h-8 w-8 items-center justify-center rounded-full text-text-muted"
            >
              <SquareTerminal className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onOpenFolder}
              title="在文件管理器中打开"
              aria-label="打开工作区目录"
              className="ui-btn-round ui-icon-action flex h-8 w-8 items-center justify-center rounded-full text-text-muted"
            >
              <FolderOpen className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={openMenu}
              title="更多操作"
              aria-label="更多操作"
              className="ui-btn-round ui-icon-action flex h-8 w-8 items-center justify-center rounded-full text-text-muted"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </>
        }
      />

      {/* Tab 栏 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-card py-2">
        <SegmentedTabs
          value={tab}
          onChange={(next) => onTabChange(next as WorkspaceTab)}
          options={[
            { id: "files", label: "文件" },
            {
              id: "git",
              label: "Git",
              count: git?.available ? changes : undefined,
            },
          ]}
        />

        <button
          type="button"
          onClick={refreshGit}
          title="刷新 Git 状态"
          aria-label="刷新"
          className="ui-btn-round ui-icon-action flex h-7 w-7 items-center justify-center rounded-full text-text-muted"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${gitLoading ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {/* Tab 内容：两个都挂载，切换保留状态 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div
          className={
            tab === "files" ? "flex h-full min-h-0 flex-col" : "hidden"
          }
        >
          <FilesTab
            project={project}
            git={git}
            request={filesRequest}
            revision={revision}
          />
        </div>

        <div
          className={tab === "git" ? "flex h-full min-h-0 flex-col" : "hidden"}
        >
          <GitTab
            project={project}
            status={git}
            branches={branches}
            commits={commits}
            loading={gitLoading}
            onRefresh={refreshGit}
            onAfterMutation={afterWorkspaceMutation}
            onOpenFile={(relativePath) => openFiles({ relativePath })}
          />
        </div>
      </div>

      {menu && (
        <div
          className="contents"
          onClick={(event) => event.stopPropagation()}
        >
          <MenuPanel x={menu.x} y={menu.y} menuRef={menuRef}>
            <MenuItem
              icon={Copy}
              label="复制路径"
              onClick={() => {
                setMenu(null);
                onCopyPath();
              }}
            />
            <MenuItem
              icon={FolderKanban}
              label="在会话文件树中打开"
              onClick={() => {
                setMenu(null);
                onBrowseFilesInChat();
              }}
            />
            <MenuSeparator />
            <MenuItem
              icon={Trash2}
              label="删除工作区"
              danger
              onClick={() => {
                setMenu(null);
                onDelete();
              }}
            />
          </MenuPanel>
        </div>
      )}
    </div>
  );
}
