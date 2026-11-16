/**
 * 工作区控制台
 *
 * 右侧工作台：头部（工作区名 / 动作） + 两个 Tab：文件 / Git。
 * 分支信息只出现在 Git Tab 内（顶栏选择器），头部不再重复展示。
 * 两个 Tab 常驻挂载，切换不丢文件预览标签和 Git 提交草稿。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  FolderKanban,
  FolderOpen,
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
import { IconButton } from "../ui/IconButton";
import { PageHeader } from "../ui/Page";
import { SegmentedTabs } from "../ui/SegmentedTabs";
import { useElementVisible } from "../../hooks/useElementVisible";
import { useGitStatusRefresh } from "../../hooks/useGitStatusRefresh";
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
  onDelete: () => void;
}

export function WorkspaceConsole({
  project,
  tab,
  onTabChange,
  onOpenFolder,
  onOpenTerminal,
  onDelete,
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

  const rootRef = useRef<HTMLDivElement>(null);
  /** 页面被侧栏切走时整块 hidden：不保留监听、也不后台刷 Git */
  const visible = useElementVisible(rootRef);
  const projectIdRef = useRef(project.id);
  projectIdRef.current = project.id;

  /** 轻量刷新：只拉 Git 状态，不重拉分支 / 日志（那是全量刷新的事） */
  const gitStatusInflight = useRef(false);
  const refreshGitStatus = useCallback(() => {
    const id = projectIdRef.current;
    if (!id || gitStatusInflight.current) return;
    gitStatusInflight.current = true;
    void ipc
      .getGitStatusDetail(id)
      .then((status) => {
        if (projectIdRef.current === id) setGit(status);
      })
      .catch(() => {
        // 保留旧值
      })
      .finally(() => {
        gitStatusInflight.current = false;
      });
  }, []);
  useGitStatusRefresh(
    project.id,
    visible,
    refreshGitStatus,
    "git-status-console",
  );

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
          inProgress: null,
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

  return (
    <div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        icon={<FolderKanban className="h-4 w-4" />}
        title={project.name}
        subtitle={project.cwd}
        hue="teal"
        actions={
          <>
            <IconButton
              icon={<SquareTerminal className="h-4 w-4" />}
              label="在此工作区打开终端"
              tone="muted"
              onClick={onOpenTerminal}
            />
            <IconButton
              icon={<FolderOpen className="h-4 w-4" />}
              label="在文件管理器中打开"
              tone="muted"
              onClick={onOpenFolder}
            />
            <IconButton
              icon={<Trash2 className="h-4 w-4" />}
              label="删除工作区"
              tone="danger"
              onClick={onDelete}
            />
          </>
        }
      />

      {/* Tab 栏 */}
      <div className="flex shrink-0 items-center border-b border-border px-card py-2">
        <SegmentedTabs
          options={[
            { id: "files", label: "文件" },
            {
              id: "git",
              label: "Git",
              title: git?.inProgress?.label,
              icon: git?.inProgress ? (
                <AlertTriangle
                  className="h-3 w-3 shrink-0 text-agent-amber"
                  aria-label={git.inProgress.label}
                />
              ) : undefined,
              count:
                git?.available && changes > 0 ? changes : undefined,
            },
          ]}
          value={tab}
          onChange={onTabChange}
        />
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

    </div>
  );
}
