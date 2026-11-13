/**
 * 文件 Tab：目录树浏览 + 预览
 *
 * 只做按需展开：进入页面只读根目录，展开哪个目录才读哪个目录。
 * 不做全盘文件索引 / 统计 —— 大仓库下逐个 stat 会明显拖慢页面。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FolderOpen, X } from "lucide-react";
import type { FileEntry, GitStatusKind, Project } from "@shared/types";
import type { GitStatusDetail } from "@shared/git";
import type { FileTab } from "../../stores/fileViewer";
import { ipc } from "../../lib/ipc";
import {
  clearWatchSource,
  setWatchSource,
  subscribeWorkspaceChanges,
} from "../../lib/file-watch";
import { toMessage } from "../../lib/utils";
import { useElementVisible } from "../../hooks/useElementVisible";
import {
  readExpandedPaths,
  writeExpandedPaths,
} from "../../lib/tree-expansion";
import { WorkspaceEmptyState } from "./workspaceUi";
import { FileTypeIcon } from "../ui/FileTypeIcon";
import { FolderTypeIcon } from "../ui/FolderTypeIcon";
import { FilePreview } from "../files/FilePreview";
import { displayStatus, GIT_STATUS_META } from "./gitUi";
import { Spinner } from "../ui/Spinner";

export interface FilesRequest {
  nonce: number;
  relativePath?: string;
}

export interface FilesTabProps {
  project: Project;
  git: GitStatusDetail | null;
  request: FilesRequest | null;
  /** 分支切换等会改变工作区文件内容：值变化时重新加载 */
  revision: number;
}

export function FilesTab({ project, git, request, revision }: FilesTabProps) {
  const [rootItems, setRootItems] = useState<FileEntry[]>([]);
  const [childrenByPath, setChildrenByPath] = useState<
    Record<string, FileEntry[]>
  >({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [openTabs, setOpenTabs] = useState<FileTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const projectIdRef = useRef(project.id);
  projectIdRef.current = project.id;
  const lastRequestNonce = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 工作区页切走 / 切到 Git 标签时本组件仍在 DOM 里：隐藏时停掉监听 */
  const visible = useElementVisible(rootRef);

  // 根目录懒加载
  useEffect(() => {
    let cancelled = false;
    setRootItems([]);
    setChildrenByPath({});
    // 重载（Vite 热更新 / 视图重新挂载）后恢复上次展开的目录
    const restored = readExpandedPaths(project.id);
    setExpanded(restored);
    setTreeError(null);
    setLoadingPaths(new Set([""]));

    ipc
      .listFiles(project.id)
      .then((entries) => {
        if (!cancelled) setRootItems(entries);
      })
      .catch((err) => {
        if (!cancelled) setTreeError(toMessage(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete("");
          return next;
        });
      });

    // 恢复展开状态时把子目录一并读回来，避免出现「展开但内容为空」
    for (const dir of restored) {
      setLoadingPaths((current) => new Set(current).add(dir));
      ipc
        .listFiles(project.id, dir)
        .then((entries) => {
          if (cancelled) return;
          setChildrenByPath((current) => ({ ...current, [dir]: entries }));
        })
        .catch(() => {
          // 目录已不存在：保留展开标记，下次点击重新判断
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
  }, [project.id, reloadKey, revision]);

  /** 文件变更回调读到的必须是最新展开状态 */
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  /** 只重拉发生变化、且仍然展开的目录；根目录始终重拉 */
  const refreshChangedDirs = useCallback(async (dirs: string[]) => {
    const requestProjectId = projectIdRef.current;
    await Promise.all(
      dirs.map(async (dir) => {
        if (dir !== "" && !expandedRef.current.has(dir)) return;
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

  /** 监听集合 = 根目录 + 已展开目录；标签页切走或页面隐藏时停止 */
  useEffect(() => {
    if (!visible) return;
    setWatchSource(project.id, "files-tab", ["", ...expanded]);
    return () => clearWatchSource(project.id, "files-tab");
  }, [project.id, expanded, visible]);

  useEffect(() => {
    return subscribeWorkspaceChanges(project.id, (dirs) => {
      void refreshChangedDirs(dirs);
    });
  }, [project.id, refreshChangedDirs]);

  const statusByPath = useMemo(() => {
    const map = new Map<string, GitStatusKind>();
    for (const file of git?.available ? git.files : []) {
      map.set(file.relativePath, displayStatus(file));
    }
    return map;
  }, [git]);

  const directoryChanges = useMemo(() => {
    const map = new Map<string, number>();
    for (const file of git?.available ? git.files : []) {
      let parent = file.relativePath;
      while (true) {
        const slash = parent.lastIndexOf("/");
        if (slash < 0) break;
        parent = parent.slice(0, slash);
        map.set(parent, (map.get(parent) ?? 0) + 1);
      }
    }
    return map;
  }, [git]);

  const openFile = useCallback(
    (relativePath: string, name: string) => {
      const tab: FileTab = {
        kind: "file",
        id: `${project.id}:${relativePath}`,
        projectId: project.id,
        relativePath,
        name,
      };
      setOpenTabs((current) =>
        current.some((item) => item.id === tab.id)
          ? current
          : [...current, tab],
      );
      setActiveTabId(tab.id);
    },
    [project.id],
  );

  const closeTab = (id: string) => {
    const index = openTabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const next = openTabs.filter((tab) => tab.id !== id);
    setOpenTabs(next);
    if (activeTabId === id) {
      setActiveTabId(next[Math.min(index, next.length - 1)]?.id ?? null);
    }
  };

  // Git 页「打开文件」等外部跳转
  useEffect(() => {
    if (!request || request.nonce === lastRequestNonce.current) return;
    lastRequestNonce.current = request.nonce;

    if (request.relativePath) {
      const name =
        request.relativePath.split("/").pop() ?? request.relativePath;
      openFile(request.relativePath, name);
    }
  }, [request, openFile]);

  const toggleDirectory = async (entry: FileEntry) => {
    const path = entry.relativePath;
    if (expanded.has(path)) {
      const next = new Set(expanded);
      next.delete(path);
      setExpanded(next);
      writeExpandedPaths(project.id, next);
      return;
    }

    const next = new Set(expanded).add(path);
    setExpanded(next);
    writeExpandedPaths(project.id, next);
    if (childrenByPath[path]) return;

    const requestProjectId = projectIdRef.current;
    setLoadingPaths((current) => new Set(current).add(path));
    try {
      const entries = await ipc.listFiles(requestProjectId, path);
      if (projectIdRef.current !== requestProjectId) return;
      setChildrenByPath((current) => ({ ...current, [path]: entries }));
    } catch (err) {
      if (projectIdRef.current !== requestProjectId) return;
      setTreeError(toMessage(err));
    } finally {
      if (projectIdRef.current !== requestProjectId) return;
      setLoadingPaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
  };

  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;
  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* 树 */}
        <div className="flex w-[340px] shrink-0 flex-col border-r border-border">
          <div className="ws-tree min-h-0 flex-1 overflow-y-auto">
            {treeError ? (
              <div className="m-2 rounded-md border border-error/25 bg-error-bg px-2.5 py-2 ui-type-sub text-error">
                {treeError}
                <button
                  type="button"
                  onClick={() => setReloadKey((value) => value + 1)}
                  className="ml-2 font-medium underline"
                >
                  重试
                </button>
              </div>
            ) : loadingPaths.has("") ? (
              <div className="flex h-40 items-center justify-center text-text-muted">
                <Spinner className="h-5 w-5" />
              </div>
            ) : rootItems.length === 0 ? (
              <div className="px-3 py-8 text-center ui-type-note text-text-muted">
                空目录
              </div>
            ) : (
              <TreeNodes
                entries={rootItems}
                depth={0}
                childrenByPath={childrenByPath}
                expanded={expanded}
                loadingPaths={loadingPaths}
                statusByPath={statusByPath}
                directoryChanges={directoryChanges}
                onToggle={toggleDirectory}
                onOpen={openFile}
              />
            )}
          </div>
        </div>

        {/* 预览 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <PreviewTabs
            tabs={openTabs}
            activeId={activeTabId}
            onActivate={setActiveTabId}
            onClose={closeTab}
            onCloseAll={() => {
              setOpenTabs([]);
              setActiveTabId(null);
            }}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            {activeTab ? (
              <FilePreview
                tab={activeTab}
                onClose={() => closeTab(activeTab.id)}
              />
            ) : (
              <WorkspaceEmptyState
                icon={<FolderOpen className="h-5 w-5" />}
                title="选择左侧文件预览"
                description="文本、Markdown、CSV、图片和 PDF 可以直接在应用内查看；Office 等二进制文件会交给系统程序。"
                className="h-full"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 树
// ============================================================================

interface TreeSharedProps {
  childrenByPath: Record<string, FileEntry[]>;
  expanded: Set<string>;
  loadingPaths: Set<string>;
  statusByPath: Map<string, GitStatusKind>;
  directoryChanges: Map<string, number>;
  onToggle: (entry: FileEntry) => void;
  onOpen: (relativePath: string, name: string) => void;
}

function TreeNodes({
  entries,
  depth,
  ...shared
}: {
  entries: FileEntry[];
  depth: number;
} & TreeSharedProps) {
  return (
    <div className="space-y-0.5">
      {entries.map((entry) => (
        <TreeNode
          key={entry.relativePath}
          entry={entry}
          depth={depth}
          {...shared}
        />
      ))}
    </div>
  );
}

function TreeNode({
  entry,
  depth,
  childrenByPath,
  expanded,
  loadingPaths,
  statusByPath,
  directoryChanges,
  onToggle,
  onOpen,
}: {
  entry: FileEntry;
  depth: number;
} & TreeSharedProps) {
  const status = statusByPath.get(entry.relativePath);
  const directoryChangeCount = entry.isDirectory
    ? (directoryChanges.get(entry.relativePath) ?? 0)
    : 0;

  if (entry.isDirectory) {
    const open = expanded.has(entry.relativePath);
    const loading = loadingPaths.has(entry.relativePath);

    return (
      <div>
        <button
          type="button"
          onClick={() => onToggle(entry)}
          title={entry.relativePath}
          className="ws-tree-row"
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
              open ? "rotate-90" : ""
            }`}
          />
          <FolderTypeIcon open={open} />
          <span className="ws-tree-name">{entry.name}</span>
          {directoryChangeCount > 0 && (
            <span
              title={`${directoryChangeCount} 个文件有变更`}
              className="ws-counter"
              data-tone="warning"
            >
              {directoryChangeCount}
            </span>
          )}
          {loading && (
            <Spinner className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          )}
        </button>

        {open && (
          <TreeNodes
            entries={childrenByPath[entry.relativePath] ?? []}
            depth={depth + 1}
            childrenByPath={childrenByPath}
            expanded={expanded}
            loadingPaths={loadingPaths}
            statusByPath={statusByPath}
            directoryChanges={directoryChanges}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        )}
      </div>
    );
  }

  const statusMeta = status ? GIT_STATUS_META[status] : null;

  return (
    <button
      type="button"
      onClick={() => onOpen(entry.relativePath, entry.name)}
      title={entry.relativePath}
      className="ws-tree-row"
      style={{ paddingLeft: 30 + depth * 14 }}
    >
      <FileTypeIcon
        name={entry.name}
        toneClassName={statusMeta?.textClass}
      />
      <span className="ws-tree-name">{entry.name}</span>
      {statusMeta && (
        <span
          title={statusMeta.text}
          className="ws-status"
          data-status={status ?? "changed"}
        >
          {statusMeta.label}
        </span>
      )}
    </button>
  );
}

// ============================================================================
// 预览标签
// ============================================================================

function PreviewTabs({
  tabs,
  activeId,
  onActivate,
  onClose,
  onCloseAll,
}: {
  tabs: FileTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseAll: () => void;
}) {
  if (tabs.length === 0) return null;

  return (
    <div className="ws-preview-tabs">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <span
            key={tab.id}
            className="ws-preview-tab"
            data-active={active}
          >
            <button
              type="button"
              onClick={() => onActivate(tab.id)}
              title={tab.relativePath}
              className="flex min-w-0 items-center gap-1.5"
            >
              <FileTypeIcon name={tab.name} size={14} />
              <span className="ws-preview-name">{tab.name}</span>
            </button>
            <button
              type="button"
              onClick={() => onClose(tab.id)}
              title="关闭"
              aria-label={`关闭 ${tab.name}`}
              className="shrink-0 rounded-sm p-0.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        onClick={onCloseAll}
        className="ml-auto shrink-0 px-1.5 ui-type-sub text-text-muted hover:text-text"
      >
        全部关闭
      </button>
    </div>
  );
}
