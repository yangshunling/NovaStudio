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
import { toMessage } from "../../lib/utils";
import { EmptyState } from "../ui/EmptyState";
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

  // 根目录懒加载
  useEffect(() => {
    let cancelled = false;
    setRootItems([]);
    setChildrenByPath({});
    setExpanded(new Set());
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

    return () => {
      cancelled = true;
    };
  }, [project.id, reloadKey, revision]);

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
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }

    setExpanded((current) => new Set(current).add(path));
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* 树 */}
        <div className="flex w-[340px] shrink-0 flex-col border-r border-border">
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {treeError ? (
              <div className="m-2 rounded-lg border border-error/25 bg-error-bg px-2.5 py-2 ui-type-sub text-error">
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
              <EmptyState size="compact" title="空目录" />
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
              <EmptyState
                size="compact"
                icon={<FolderOpen />}
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
          className="flex h-7 w-full items-center gap-1.5 rounded-sm pr-1.5 text-left ui-type-body text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
              open ? "rotate-90" : ""
            }`}
          />
          <FolderTypeIcon open={open} />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {directoryChangeCount > 0 && (
            <span
              title={`${directoryChangeCount} 个文件有变更`}
              className="shrink-0 rounded-full bg-agent-amber/10 px-1.5 ui-type-code-sm leading-4 text-agent-amber"
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
      className={`flex h-7 w-full items-center gap-1.5 rounded-sm pr-1.5 text-left ui-type-body transition-colors hover:bg-surface-hover hover:text-text ${
        statusMeta ? "text-text" : "text-text-secondary"
      }`}
      style={{ paddingLeft: 30 + depth * 14 }}
    >
      <FileTypeIcon
        name={entry.name}
        toneClassName={statusMeta?.textClass}
      />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {statusMeta && (
        <span
          title={statusMeta.text}
          className={`shrink-0 rounded-full px-1.5 ui-type-sub font-medium leading-4 ${statusMeta.badge}`}
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
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <span
            key={tab.id}
            className={`flex h-7 max-w-52 shrink-0 items-center gap-1 rounded-sm px-2 ui-type-note ${
              active
                ? "bg-surface-active text-text"
                : "text-text-muted hover:bg-surface-hover hover:text-text"
            }`}
          >
            <button
              type="button"
              onClick={() => onActivate(tab.id)}
              title={tab.relativePath}
              className="min-w-0 truncate"
            >
              {tab.name}
            </button>
            <button
              type="button"
              onClick={() => onClose(tab.id)}
              title="关闭"
              aria-label={`关闭 ${tab.name}`}
              className="shrink-0 rounded-sm p-0.5 hover:bg-surface-hover"
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
