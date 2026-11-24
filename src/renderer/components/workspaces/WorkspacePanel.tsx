/**
 * 工作区文件面板
 *
 * 右侧第三栏，按当前项目 cwd 懒加载目录树。
 * 根目录与每个展开的目录分别走 project:listFiles，避免一次扫描整个工程。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtSign, ChevronRight, FolderOpen, Trash2 } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import {
  clearWatchSource,
  setWatchSource,
  subscribeWorkspaceChanges,
} from "../../lib/file-watch";
import { useChatStore } from "../../stores/chat";
import { useFileViewerStore } from "../../stores/fileViewer";
import { useElementVisible } from "../../hooks/useElementVisible";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { useGitStatusRefresh } from "../../hooks/useGitStatusRefresh";
import {
  readExpandedPaths,
  writeExpandedPaths,
} from "../../lib/tree-expansion";
import { clampMenuPosition } from "../../lib/popup";
import {
  requestComposerFocus,
  requestComposerReference,
} from "../../lib/chat-events";
import { MENU_WIDTH, MenuItem, MenuPanel, MenuSeparator } from "../ui/Menu";
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

/** 文件树右键菜单尺寸：引用 + 分割线 + 删除 */
const TREE_MENU_HEIGHT = 96;

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
    badge: "text-success",
  },
  added: {
    label: "A",
    textClass: "text-success",
    badge: "text-success",
  },
  modified: {
    label: "M",
    textClass: "text-accent",
    badge: "text-accent",
  },
  deleted: {
    label: "D",
    textClass: "text-error",
    badge: "text-error",
  },
  renamed: {
    label: "R",
    textClass: "text-text-muted",
    badge: "text-text-muted",
  },
  copied: {
    label: "C",
    textClass: "text-text-muted",
    badge: "text-text-muted",
  },
  conflicted: {
    label: "!",
    textClass: "text-error",
    badge: "text-error",
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
  const activateCenterTab = useFileViewerStore((s) => s.activateTab);
  /** 对话当前绑定的工作区：面板跟随终端时可能与展示的工作区不同 */
  const chatProjectId = storeProject?.id ?? "";

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
  }, [projectId]);

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

  /**
   * 右键「引用到输入框」。
   *
   * 面板与对话绑定同一工作区时用相对路径（与 `#` 文件引用一致）；
   * 跟随终端展示别的工作区时改用绝对路径，避免 Agent 按错误根目录解析。
   * 引用标签挂在对话输入框上方，因此顺手把中心区切回对话并聚焦。
   */
  const referenceFile = useCallback(
    (entry: FileEntry, owner: Project) => {
      const sameWorkspace = owner.id === chatProjectId;
      const path = sameWorkspace
        ? entry.relativePath
        : `${owner.cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${entry.relativePath}`;
      requestComposerReference({
        key: `file:${path}`,
        category: "file",
        name: entry.name,
        detail: path,
        promptText: `@${path}`,
        isDirectory: entry.isDirectory,
      });
      activateCenterTab(null);
      requestComposerFocus();
    },
    [chatProjectId, activateCenterTab],
  );

  /**
   * 右键「删除文件 / 文件夹」。
   *
   * 删除前必须二次确认；文件和文件夹都移入系统回收站（整棵子树可整体找回）。
   * 成功后先本地摘除该行（监听事件随后触发的重拉是幂等的），并清理指向它的
   * 预览标签与展开状态，避免留下打不开的页签和点不开的目录。
   */
  const deleteFile = useCallback(async (entry: FileEntry, owner: Project) => {
    const target = entry.isDirectory ? "文件夹" : "文件";
    const confirmed = await confirmDialog({
      title: `删除${target}「${entry.name}」？`,
      message: `${entry.relativePath}\n\n${
        entry.isDirectory ? "文件夹及其中所有内容" : "文件"
      }会移入系统回收站。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) return;

    try {
      await ipc.deleteProjectFile(owner.id, entry.relativePath);
    } catch (err) {
      toast.error(toMessage(err), 5000);
      return;
    }

    /** 自身与全部后代（文件树路径统一以 / 分隔） */
    const prefix = `${entry.relativePath}/`;
    const isUnder = (path: string) =>
      path === entry.relativePath || path.startsWith(prefix);

    // 父目录列表里摘掉这一行
    const slash = entry.relativePath.lastIndexOf("/");
    const parent = slash >= 0 ? entry.relativePath.slice(0, slash) : "";
    const without = (list: FileEntry[]) =>
      list.filter((item) => item.relativePath !== entry.relativePath);
    if (parent) {
      setChildrenByPath((current) =>
        current[parent]
          ? { ...current, [parent]: without(current[parent]) }
          : current,
      );
    } else {
      setRootItems(without);
    }

    if (entry.isDirectory) {
      // 已缓存的后代目录列表与展开记录一并丢弃：目录已不存在，留着会挡住重建
      setChildrenByPath((current) => {
        const next = { ...current };
        for (const key of Object.keys(next)) if (isUnder(key)) delete next[key];
        return next;
      });
      const current = expandedPathsRef.current;
      const next = new Set([...current].filter((path) => !isUnder(path)));
      if (next.size !== current.size) {
        setExpandedPaths(next);
        writeExpandedPaths(owner.id, next);
      }
    }

    // 该文件 / 该目录下的预览标签统一关掉
    const viewer = useFileViewerStore.getState();
    const closing = viewer.tabs
      .filter(
        (tab) => tab.projectId === owner.id && isUnder(tab.relativePath),
      )
      .map((tab) => tab.id);
    if (closing.length > 0) {
      const wasActive =
        viewer.activeTabId !== null && closing.includes(viewer.activeTabId);
      viewer.closeTabs(closing);
      if (wasActive) {
        const remaining = useFileViewerStore.getState().tabs;
        useFileViewerStore
          .getState()
          .activateTab(remaining[remaining.length - 1]?.id ?? null);
      }
    }

    toast.success(`已删除 ${entry.name}`, 4000);
  }, []);

  const isLoadingRoot = loadingPaths.has("");
  const hasWorkspace = Boolean(cwd);

  /** 在系统资源管理器中打开当前工作区目录 */
  const openInExplorer = useCallback(async () => {
    if (!project) return;
    try {
      const opened = await ipc.revealProject(project.id);
      if (!opened) throw new Error("工作区目录不存在");
    } catch (err) {
      toast.error(toMessage(err), 5000);
    }
  }, [project]);
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
          hue="teal"
          subtitle={cwd || "尚未选择工作区"}
          actions={
            <IconButton
              icon={<FolderOpen className="h-4 w-4" />}
              label="在资源管理器中打开"
              tone="muted"
              disabled={!project}
              onClick={() => void openInExplorer()}
            />
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
              onReferenceFile={(entry) => {
                if (project) referenceFile(entry, project);
              }}
              onDeleteFile={(entry) => {
                if (project) void deleteFile(entry, project);
              }}
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
  onReferenceFile,
  onDeleteFile,
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
  /** 右键：把文件 / 目录路径引用到输入框 */
  onReferenceFile: (entry: FileEntry) => void;
  /** 右键：删除文件 / 文件夹（移入系统回收站） */
  onDeleteFile: (entry: FileEntry) => void;
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
          onReferenceFile={onReferenceFile}
          onDeleteFile={onDeleteFile}
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
  onReferenceFile,
  onDeleteFile,
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
  onReferenceFile: (entry: FileEntry) => void;
  onDeleteFile: (entry: FileEntry) => void;
}) {
  /** 右键菜单坐标（视口坐标）；null 表示关闭 */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissableLayer(Boolean(menu), () => setMenu(null), [menuRef]);

  const openMenuAt = (x: number, y: number) => {
    setMenu(
      clampMenuPosition(x, y, {
        width: MENU_WIDTH,
        height: TREE_MENU_HEIGHT,
      }),
    );
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openMenuAt(event.clientX, event.clientY);
  };

  /** 键盘打开菜单：菜单键或 Shift+F10，位置贴住行的右下角 */
  const handleMenuKey = (event: React.KeyboardEvent) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    openMenuAt(rect.right - MENU_WIDTH, rect.bottom + 4);
  };

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
          onContextMenu={handleContextMenu}
          onKeyDown={handleMenuKey}
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
              className="shrink-0 ui-type-sub tabular-nums leading-4 text-agent-amber"
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
          onContextMenu={handleContextMenu}
          onKeyDown={handleMenuKey}
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
              className={`w-4 shrink-0 text-center ui-type-sub font-medium leading-4 ${statusMeta.badge}`}
            >
              {statusMeta.label}
            </span>
          )}
        </button>
      )}

      {/*
        右键菜单挂在行的外层，而不是按钮内部：portal 里的点击会沿 React 树
        冒泡回来，外层没有 onClick，不会误触「展开目录 / 打开文件」。
      */}
      {menu && (
        <MenuPanel x={menu.x} y={menu.y} menuRef={menuRef}>
          <MenuItem
            icon={AtSign}
            label="引用到输入框"
            onClick={() => {
              setMenu(null);
              onReferenceFile(entry);
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={Trash2}
            label={entry.isDirectory ? "删除文件夹" : "删除文件"}
            danger
            disabled={status === "deleted"}
            onClick={() => {
              setMenu(null);
              onDeleteFile(entry);
            }}
          />
        </MenuPanel>
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
          onReferenceFile={onReferenceFile}
          onDeleteFile={onDeleteFile}
        />
      )}
    </div>
  );
}
