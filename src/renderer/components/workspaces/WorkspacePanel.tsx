/**
 * 工作区文件面板
 *
 * 右侧第三栏，按当前项目 cwd 懒加载目录树。
 * 根目录与每个展开的目录分别走 project:listFiles，避免一次扫描整个工程。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight, GitBranch, PanelRightClose, RefreshCw } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { useChatStore } from "../../stores/chat";
import { useFileViewerStore } from "../../stores/fileViewer";
import { FileTypeIcon } from "../ui/FileTypeIcon";
import { FolderTypeIcon } from "../ui/FolderTypeIcon";
import { PageHeader, PageToolbar } from "../ui/Page";
import { IconButton } from "../ui/IconButton";
import type {
  FileEntry,
  GitStatusKind,
  GitStatusSummary,
  Project,
} from "@shared/types";
import { clamp } from "@shared/math";
import { Spinner } from "../ui/Spinner";

const WORKSPACE_WIDTH_KEY = "nova-workspace-width";
const DEFAULT_WORKSPACE_WIDTH = 320;
const MIN_WORKSPACE_WIDTH = 240;
const MAX_WORKSPACE_WIDTH = 560;

function clampWidth(width: number): number {
  return clamp(width, MIN_WORKSPACE_WIDTH, MAX_WORKSPACE_WIDTH);
}

function readStoredWidth(): number | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_WIDTH_KEY);
    if (!raw) return null;
    const width = Number(raw);
    return Number.isFinite(width) ? clampWidth(width) : null;
  } catch {
    return null;
  }
}

interface GitStatusMeta {
  label: string;
  textClass: string;
  /** 行尾状态胶囊的底色 + 文字色 */
  badge: string;
}

interface DirectoryGitStatus {
  status: GitStatusKind;
  count: number;
}

const GIT_STATUS_META: Record<GitStatusKind, GitStatusMeta> = {
  untracked: {
    label: "U",
    textClass: "text-success",
    badge: "bg-success/10 text-success",
  },
  added: {
    label: "A",
    textClass: "text-success",
    badge: "bg-success/10 text-success",
  },
  modified: {
    label: "M",
    textClass: "text-accent",
    badge: "bg-accent-soft text-accent",
  },
  deleted: {
    label: "D",
    textClass: "text-error",
    badge: "bg-error/10 text-error",
  },
  renamed: {
    label: "R",
    textClass: "text-agent-sky",
    badge: "bg-agent-sky/10 text-agent-sky",
  },
  copied: {
    label: "C",
    textClass: "text-agent-teal",
    badge: "bg-agent-teal/10 text-agent-teal",
  },
  conflicted: {
    label: "!",
    textClass: "text-error",
    badge: "bg-error/10 text-error",
  },
  changed: {
    label: "M",
    textClass: "text-text-secondary",
    badge: "bg-surface-hover text-text-muted",
  },
};

const GIT_STATUS_PRIORITY: Record<GitStatusKind, number> = {
  changed: 0,
  modified: 1,
  copied: 2,
  renamed: 3,
  added: 4,
  untracked: 4,
  deleted: 5,
  conflicted: 6,
};

function buildGitStatusIndex(status: GitStatusSummary | null): {
  statusByPath: Map<string, GitStatusKind>;
  directoryStatusByPath: Map<string, DirectoryGitStatus>;
} {
  const statusByPath = new Map<string, GitStatusKind>();
  const directoryStatusByPath = new Map<string, DirectoryGitStatus>();
  if (!status?.available) return { statusByPath, directoryStatusByPath };

  for (const file of status.files) {
    statusByPath.set(file.relativePath, file.status);

    let parent = file.relativePath;
    while (true) {
      const slash = parent.lastIndexOf("/");
      if (slash < 0) break;
      parent = parent.slice(0, slash);

      const current = directoryStatusByPath.get(parent);
      if (!current) {
        directoryStatusByPath.set(parent, { status: file.status, count: 1 });
      } else {
        directoryStatusByPath.set(parent, {
          status:
            GIT_STATUS_PRIORITY[file.status] > GIT_STATUS_PRIORITY[current.status]
              ? file.status
              : current.status,
          count: current.count + 1,
        });
      }
    }
  }

  return { statusByPath, directoryStatusByPath };
}

function overlayDeletedEntries(
  entries: FileEntry[],
  directoryPath: string,
  deletedPaths: string[],
): FileEntry[] {
  if (deletedPaths.length === 0) return entries;

  const existingPaths = new Set(entries.map((entry) => entry.relativePath));
  const additions = new Map<string, FileEntry>();
  const prefix = directoryPath ? `${directoryPath}/` : "";

  for (const deletedPath of deletedPaths) {
    if (!deletedPath.startsWith(prefix)) continue;
    const remainder = deletedPath.slice(prefix.length);
    if (!remainder) continue;

    const slash = remainder.indexOf("/");
    const isDirectory = slash >= 0;
    const relativePath = isDirectory
      ? `${prefix}${remainder.slice(0, slash)}`
      : deletedPath;
    if (existingPaths.has(relativePath) || additions.has(relativePath)) continue;

    additions.set(relativePath, {
      name: relativePath.slice(relativePath.lastIndexOf("/") + 1),
      relativePath,
      isDirectory,
    });
  }

  if (additions.size === 0) return entries;
  return [...entries, ...additions.values()].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export interface WorkspacePanelProps {
  /**
   * 要展示的工作区。对话标签不传，取当前会话绑定的工作区；
   * 终端标签由外层传入终端所属的工作区。
   */
  project?: Project | null;
}

export function WorkspacePanel({
  project: projectProp,
}: WorkspacePanelProps = {}) {
  const storeProject = useChatStore(
    (s) => s.projects.find((p) => p.id === s.currentProjectId) ?? null,
  );
  const project = projectProp === undefined ? storeProject : projectProp;
  const openFile = useFileViewerStore((s) => s.openFile);
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const setShowWorkspace = useChatStore((s) => s.setShowWorkspace);

  const handleOpenFile = (entry: FileEntry, owner: Project) => {
    openFile(owner.id, entry.relativePath, entry.name);
  };

  const cwd = project?.cwd ?? "";
  const projectId = project?.id ?? "";
  const projectIdRef = useRef(projectId);
  const [rootItems, setRootItems] = useState<FileEntry[]>([]);
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FileEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatusSummary | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [panelWidth, setPanelWidth] = useState<number | null>(readStoredWidth);
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  useEffect(() => {
    if (panelWidth === null) return;
    try {
      localStorage.setItem(WORKSPACE_WIDTH_KEY, String(Math.round(panelWidth)));
    } catch {
      // localStorage 不可用时忽略：不影响本次拖拽
    }
  }, [panelWidth]);

  useEffect(() => {
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    setRootItems([]);
    setChildrenByPath({});
    setExpandedPaths(new Set());
    setError(null);
    setGitStatus(null);

    if (!projectId) {
      setLoadingPaths(new Set());
      return;
    }

    setLoadingPaths(new Set([""]));
    ipc
      .listFiles(projectId)
      .then((entries) => {
        if (cancelled) return;
        setRootItems(entries);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete("");
          return next;
        });
      });

    ipc
      .getGitStatus(projectId)
      .then((status) => {
        if (cancelled) return;
        setGitStatus(status);
      })
      .catch(() => {
        if (cancelled) return;
        setGitStatus({ available: false, branch: null, files: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  const toggleDirectory = async (entry: FileEntry) => {
    if (expandedPaths.has(entry.relativePath)) {
      setExpandedPaths((current) => {
        const next = new Set(current);
        next.delete(entry.relativePath);
        return next;
      });
      return;
    }

    setExpandedPaths((current) => new Set(current).add(entry.relativePath));
    if (childrenByPath[entry.relativePath]) return;

    const requestProjectId = projectId;
    setLoadingPaths((current) => new Set(current).add(entry.relativePath));
    try {
      const entries = await ipc.listFiles(requestProjectId, entry.relativePath);
      if (projectIdRef.current !== requestProjectId) return;
      setChildrenByPath((current) => ({
        ...current,
        [entry.relativePath]: entries,
      }));
    } catch (err) {
      if (projectIdRef.current !== requestProjectId) return;
      setError(String(err));
    } finally {
      if (projectIdRef.current !== requestProjectId) return;
      setLoadingPaths((current) => {
        const next = new Set(current);
        next.delete(entry.relativePath);
        return next;
      });
    }
  };

  const isLoadingRoot = loadingPaths.has("");
  const hasWorkspace = Boolean(cwd);
  const effectiveWidth = panelWidth ?? DEFAULT_WORKSPACE_WIDTH;
  const { statusByPath, directoryStatusByPath } = useMemo(
    () => buildGitStatusIndex(gitStatus),
    [gitStatus],
  );
  const deletedPaths = useMemo(
    () =>
      gitStatus?.available
        ? gitStatus.files
            .filter((file) => file.status === "deleted")
            .map((file) => file.relativePath)
        : [],
    [gitStatus],
  );
  const displayRootItems = useMemo(
    () => overlayDeletedEntries(rootItems, "", deletedPaths),
    [rootItems, deletedPaths],
  );
  const gitChangeCount = gitStatus?.available ? gitStatus.files.length : 0;

  const stopResize = () => {
    dragRef.current = null;
    setResizing(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const handleResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !panelRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panelRef.current.getBoundingClientRect().width,
    };
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const handleResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPanelWidth(clampWidth(drag.startWidth - (event.clientX - drag.startX)));
  };

  const resetWorkspaceWidth = () => {
    setPanelWidth(null);
    try {
      localStorage.removeItem(WORKSPACE_WIDTH_KEY);
    } catch {
      // localStorage 不可用时忽略
    }
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整工作区宽度"
        aria-valuemin={MIN_WORKSPACE_WIDTH}
        aria-valuemax={MAX_WORKSPACE_WIDTH}
        aria-valuenow={Math.round(effectiveWidth)}
        tabIndex={0}
        title="拖动调整工作区宽度，双击恢复默认"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onDoubleClick={resetWorkspaceWidth}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            setPanelWidth(clampWidth(effectiveWidth + 24));
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            setPanelWidth(clampWidth(effectiveWidth - 24));
          } else if (event.key === "Home") {
            event.preventDefault();
            resetWorkspaceWidth();
          }
        }}
        className="group relative -ml-px w-1 shrink-0 cursor-col-resize outline-none"
      >
        <span
          className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
            resizing ? "bg-accent" : "bg-border group-hover:bg-accent group-focus-visible:bg-accent"
          }`}
        />
      </div>

      <aside
        ref={panelRef}
        style={{
          width: panelWidth === null ? undefined : `${panelWidth}px`,
          minWidth: MIN_WORKSPACE_WIDTH,
          maxWidth: MAX_WORKSPACE_WIDTH,
        }}
        className="ui-glass flex h-full w-[var(--c-layout-workspace)] shrink-0 flex-col"
      >
        <PageHeader
          icon={<FolderTypeIcon open size={16} />}
          title={project?.name ?? "工作区"}
          subtitle={cwd || "尚未选择工作区"}
          actions={
            <>
              <IconButton
                icon={
                  <RefreshCw
                    className={`h-4 w-4 ${isLoadingRoot ? "animate-spin" : ""}`}
                  />
                }
                label="刷新文件"
                tone="muted"
                disabled={!hasWorkspace || isLoadingRoot}
                onClick={() => setReloadKey((value) => value + 1)}
              />
              <IconButton
                icon={<PanelRightClose className="h-4 w-4" />}
                label="收起工作区"
                tone="muted"
                onClick={() => setShowWorkspace(false)}
              />
            </>
          }
        />

        <PageToolbar className="justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 ui-type-sub font-medium text-text-muted">
              工作区文件
            </span>
            {gitStatus?.available && gitStatus.branch && (
              <span
                title={`Git 分支：${gitStatus.branch}`}
                className="flex min-w-0 items-center gap-1 rounded-full border border-accent/25 bg-accent-soft px-2 py-0.5 font-medium text-accent"
              >
                <GitBranch className="h-3 w-3 shrink-0" />
                <span className="max-w-28 truncate font-mono">{gitStatus.branch}</span>
              </span>
            )}
          </div>
          <span className="ui-type-code-sm text-text-muted">
            {gitChangeCount > 0
              ? `${gitChangeCount} 变更`
              : rootItems.length > 0
                ? `${rootItems.length} 项`
                : ""}
          </span>
        </PageToolbar>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!hasWorkspace ? (
            <PanelEmpty icon={<FolderTypeIcon size={28} />} text="选择工作区后查看文件" />
          ) : isLoadingRoot ? (
            <PanelEmpty
              icon={<Spinner className="h-6 w-6" />}
              text="正在读取工作区"
            />
          ) : error ? (
            <PanelEmpty icon={<FolderTypeIcon size={28} />} text="无法读取工作区文件" />
          ) : displayRootItems.length === 0 ? (
            <PanelEmpty icon={<FolderTypeIcon open size={28} />} text="工作区为空" />
          ) : (
            <TreeNodes
              entries={displayRootItems}
              depth={0}
              childrenByPath={childrenByPath}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              statusByPath={statusByPath}
              directoryStatusByPath={directoryStatusByPath}
              deletedPaths={deletedPaths}
              projectId={project?.id ?? ""}
              activeTabId={activeTabId}
              onOpenFile={(entry) => {
                if (project) handleOpenFile(entry, project);
              }}
              onToggleDirectory={toggleDirectory}
            />
          )}
        </div>
      </aside>
    </>
  );
}

function PanelEmpty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-text-muted">
      <span className="opacity-40">{icon}</span>
      <span className="px-6 ui-type-note">{text}</span>
    </div>
  );
}

function TreeNodes({
  entries,
  depth,
  childrenByPath,
  expandedPaths,
  loadingPaths,
  statusByPath,
  directoryStatusByPath,
  deletedPaths,
  projectId,
  activeTabId,
  onOpenFile,
  onToggleDirectory,
}: {
  entries: FileEntry[];
  depth: number;
  childrenByPath: Record<string, FileEntry[]>;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  statusByPath: Map<string, GitStatusKind>;
  directoryStatusByPath: Map<string, DirectoryGitStatus>;
  deletedPaths: string[];
  projectId: string;
  activeTabId: string | null;
  onOpenFile: (entry: FileEntry) => void;
  onToggleDirectory: (entry: FileEntry) => void;
}) {
  return (
    <div className="space-y-0.5">
      {entries.map((entry) => (
        <TreeNode
          key={entry.relativePath}
          entry={entry}
          depth={depth}
          childrenByPath={childrenByPath}
          expandedPaths={expandedPaths}
          loadingPaths={loadingPaths}
          statusByPath={statusByPath}
          directoryStatusByPath={directoryStatusByPath}
          deletedPaths={deletedPaths}
          projectId={projectId}
          activeTabId={activeTabId}
          onOpenFile={onOpenFile}
          onToggleDirectory={onToggleDirectory}
        />
      ))}
    </div>
  );
}

function TreeNode({
  entry,
  depth,
  childrenByPath,
  expandedPaths,
  loadingPaths,
  statusByPath,
  directoryStatusByPath,
  deletedPaths,
  projectId,
  activeTabId,
  onOpenFile,
  onToggleDirectory,
}: {
  entry: FileEntry;
  depth: number;
  childrenByPath: Record<string, FileEntry[]>;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  statusByPath: Map<string, GitStatusKind>;
  directoryStatusByPath: Map<string, DirectoryGitStatus>;
  deletedPaths: string[];
  projectId: string;
  activeTabId: string | null;
  onOpenFile: (entry: FileEntry) => void;
  onToggleDirectory: (entry: FileEntry) => void;
}) {
  const expanded = expandedPaths.has(entry.relativePath);
  const loading = loadingPaths.has(entry.relativePath);
  const children = useMemo(
    () =>
      overlayDeletedEntries(
        childrenByPath[entry.relativePath] ?? [],
        entry.relativePath,
        deletedPaths,
      ),
    [childrenByPath, deletedPaths, entry.relativePath],
  );
  const status = statusByPath.get(entry.relativePath);
  const statusMeta = status ? GIT_STATUS_META[status] : null;
  const directoryStatus = entry.isDirectory
    ? directoryStatusByPath.get(entry.relativePath)
    : null;
  const fileTabId = `${projectId}:${entry.relativePath}`;
  const isActiveFile = !entry.isDirectory && activeTabId === fileTabId;
  const rowClass =
    "ui-cv-row flex h-7 w-full items-center gap-1.5 rounded-sm pr-1.5 text-left ui-type-body transition-colors";

  return (
    <div>
      {entry.isDirectory ? (
        <button
          type="button"
          onClick={() => onToggleDirectory(entry)}
          title={entry.relativePath}
          className={`${rowClass} text-text-secondary hover:bg-surface-hover hover:text-text`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
          />
          <FolderTypeIcon open={expanded} />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {directoryStatus && (
            <span
              title={`${directoryStatus.count} 个文件有变更`}
              className="shrink-0 rounded-full bg-agent-amber/10 px-1.5 ui-type-code-sm leading-4 text-agent-amber"
            >
              {directoryStatus.count}
            </span>
          )}
          {loading && <Spinner className="h-3.5 w-3.5 shrink-0 text-text-muted" />}
        </button>
      ) : (
        <button
          type="button"
          disabled={status === "deleted"}
          onClick={() => onOpenFile(entry)}
          title={entry.relativePath}
          className={`${rowClass} ${
            statusMeta?.textClass ?? "text-text-secondary"
          } ${
            status === "deleted"
              ? "cursor-not-allowed opacity-70"
              : "hover:bg-surface-hover hover:text-text"
          } ${isActiveFile ? "bg-surface-active" : ""}`}
          style={{ paddingLeft: 30 + depth * 14 }}
        >
          <FileTypeIcon
            name={entry.name}
            toneClassName={statusMeta?.textClass}
          />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {statusMeta && (
            <span
              title={status}
              className={`shrink-0 rounded-full px-1.5 ui-type-sub font-medium leading-4 ${statusMeta.badge}`}
            >
              {statusMeta.label}
            </span>
          )}
        </button>
      )}

      {entry.isDirectory && expanded && children && (
        <TreeNodes
          entries={children}
          depth={depth + 1}
          childrenByPath={childrenByPath}
          expandedPaths={expandedPaths}
          loadingPaths={loadingPaths}
          statusByPath={statusByPath}
          directoryStatusByPath={directoryStatusByPath}
          deletedPaths={deletedPaths}
          projectId={projectId}
          activeTabId={activeTabId}
          onOpenFile={onOpenFile}
          onToggleDirectory={onToggleDirectory}
        />
      )}
    </div>
  );
}
