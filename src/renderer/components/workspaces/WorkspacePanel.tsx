/**
 * 工作区文件面板
 *
 * 右侧第三栏，按当前项目 cwd 懒加载目录树。
 * 根目录与每个展开的目录分别走 project:listFiles，避免一次扫描整个工程。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight, PanelRightClose, RefreshCw } from "lucide-react";
import { ipc } from "../../lib/ipc";
import {
  clearWatchSource,
  setWatchSource,
  subscribeWorkspaceChanges,
} from "../../lib/file-watch";
import { useChatStore } from "../../stores/chat";
import { useFileViewerStore } from "../../stores/fileViewer";
import { useElementVisible } from "../../hooks/useElementVisible";
import { useGitStatusRefresh } from "../../hooks/useGitStatusRefresh";
import {
  readExpandedPaths,
  writeExpandedPaths,
} from "../../lib/tree-expansion";
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
  // 同步赋值（而非 effect）：Git 刷新 hook 在 effect 里会立即读取它，
  // 必须保证项目切换后的第一个 effect 就能看到新值。
  projectIdRef.current = projectId;
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
  /** 切到别的页面时面板被隐藏：此时不保留目录监听 */
  const panelVisible = useElementVisible(panelRef);

  /*
   * Git 状态独立于目录树刷新：文件监听只覆盖已展开目录，Agent 在深层
   * 目录写文件不会产生事件。这里合并 Agent 结束 / 工作流结束 / 文件变化
   * 三类信号，并在面板重新可见时补一次。
   */
  const gitStatusInflight = useRef(false);
  const refreshGitStatus = useCallback(() => {
    const id = projectIdRef.current;
    if (!id || gitStatusInflight.current) return;
    gitStatusInflight.current = true;
    void ipc
      .getGitStatus(id)
      .then((status) => {
        if (projectIdRef.current === id) setGitStatus(status);
      })
      .catch(() => {
        // 保留旧值：一次失败不应把标记清空
      })
      .finally(() => {
        gitStatusInflight.current = false;
      });
  }, []);
  useGitStatusRefresh(
    projectId || null,
    panelVisible,
    refreshGitStatus,
    "git-status-panel",
  );
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  /** 文件变更回调里读到的必须是最新展开状态，不能是订阅那一刻的闭包 */
  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;

  /** 拖动期间的宽度只在 rAF 中提交，localStorage 松手后写一次 */
  const resizeFrameRef = useRef<number | null>(null);
  const pendingWidthRef = useRef<number | null>(null);

  const persistWidth = (width: number | null) => {
    try {
      if (width === null) {
        localStorage.removeItem(WORKSPACE_WIDTH_KEY);
      } else {
        localStorage.setItem(WORKSPACE_WIDTH_KEY, String(Math.round(width)));
      }
    } catch {
      // localStorage 不可用时忽略：不影响本次拖拽
    }
  };

  useEffect(() => {
    return () => {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    setRootItems([]);
    setChildrenByPath({});
    // 重载（Vite 热更新 / 视图重新挂载）后恢复上次展开的目录
    const restored = readExpandedPaths(projectId);
    setExpandedPaths(restored);
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

    /*
     * 恢复展开状态时必须把子目录一起读回来，否则重载后会出现
     * 「箭头是展开的、内容却是空的」。
     */
    for (const dir of restored) {
      setLoadingPaths((current) => new Set(current).add(dir));
      ipc
        .listFiles(projectId, dir)
        .then((entries) => {
          if (cancelled) return;
          setChildrenByPath((current) => ({ ...current, [dir]: entries }));
        })
        .catch(() => {
          // 目录已不存在：保留展开标记，下次点击会重新判断
        })
        .finally(() => {
          if (cancelled) return;
          setLoadingPaths((current) => {
            const next = new Set(current);
            next.delete(dir);
            return next;
          });
        });
    }

    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  /** 只重拉发生变化、且仍然展开的目录；根目录始终重拉 */
  const refreshChangedDirs = useCallback(async (dirs: string[]) => {
    const requestProjectId = projectIdRef.current;
    if (!requestProjectId) return;
    await Promise.all(
      dirs.map(async (dir) => {
        if (dir !== "" && !expandedPathsRef.current.has(dir)) return;
        try {
          const entries = await ipc.listFiles(
            requestProjectId,
            dir === "" ? undefined : dir,
          );
          if (projectIdRef.current !== requestProjectId) return;
          if (dir === "") setRootItems(entries);
          else setChildrenByPath((current) => ({ ...current, [dir]: entries }));
        } catch {
          // 目录可能在事件与刷新之间被删除：保留当前行，下次展开时重建
        }
      }),
    );
  }, []);

  /** 监听集合 = 根目录 + 已展开目录；收起目录、切项目或面板隐藏时同步收缩 */
  useEffect(() => {
    if (!projectId || !panelVisible) return;
    setWatchSource(projectId, "workspace-panel", ["", ...expandedPaths]);
    return () => clearWatchSource(projectId, "workspace-panel");
  }, [projectId, expandedPaths, panelVisible]);

  useEffect(() => {
    if (!projectId) return;
    return subscribeWorkspaceChanges(projectId, (dirs) => {
      void refreshChangedDirs(dirs);
    });
  }, [projectId, refreshChangedDirs]);

  const toggleDirectory = async (entry: FileEntry) => {
    if (expandedPaths.has(entry.relativePath)) {
      const next = new Set(expandedPaths);
      next.delete(entry.relativePath);
      setExpandedPaths(next);
      writeExpandedPaths(projectId, next);
      return;
    }

    const next = new Set(expandedPaths).add(entry.relativePath);
    setExpandedPaths(next);
    writeExpandedPaths(projectId, next);
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
    if (resizeFrameRef.current !== null) {
      cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    const pending = pendingWidthRef.current;
    pendingWidthRef.current = null;
    if (pending !== null) {
      setPanelWidth(pending);
      persistWidth(pending);
    }
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
    pendingWidthRef.current = clampWidth(
      drag.startWidth - (event.clientX - drag.startX),
    );
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      if (pendingWidthRef.current !== null) {
        setPanelWidth(pendingWidthRef.current);
      }
    });
  };

  const resetWorkspaceWidth = () => {
    setPanelWidth(null);
    pendingWidthRef.current = null;
    persistWidth(null);
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
            const next = clampWidth(effectiveWidth + 24);
            setPanelWidth(next);
            persistWidth(next);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            const next = clampWidth(effectiveWidth - 24);
            setPanelWidth(next);
            persistWidth(next);
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
          <span className="shrink-0 ui-type-sub font-medium text-text-muted">
            工作区文件
          </span>
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
    "ui-cv-row flex h-control-sm w-full items-center gap-1.5 rounded-sm pr-1.5 text-left ui-type-body transition-colors";

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
