/**
 * 知识库页面
 *
 * 两栏结构（与工作流一致）：
 * - 左：知识库列表，新建 / 重命名 / 删除
 * - 右：当前知识库的文件与子文件夹，上传、建文件夹、全文检索
 *   文本类文件可在 Nova 内预览编辑并进入索引，其余格式仅存储 / 系统程序打开
 *
 * 知识库目录是唯一事实来源；页面只做索引与文件操作。
 * 数字员工在「知识库」标签页里勾选引用，工作流运行时注入给 Agent。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MENU_WIDTH,
  MenuItem,
  MenuPanel,
  MenuSeparator,
} from "../ui/Menu";
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Library,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { formatBytes, isSameText, normalizeNewlines, toMessage } from "../../lib/utils";
import {
  useAssetCatalog,
  useKnowledgeBasesStore,
} from "../../stores/assets";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import { countUsage, useEmployeesStore } from "../../stores/employees";
import { formatAssetTime } from "../asset/AssetUi";
import { CodeTextarea, EditorBar } from "../asset/EditorUi";
import { Field, TextArea, TextInput } from "../ui/Field";
import { Page, PageBody, PageHeader, PageToolbar } from "../ui/Page";
import { SearchInput } from "../ui/SearchInput";
import { ListItem, ListPane } from "../ui/ListPane";
import {
  EmptyBlock,
  EmptyState,
  ErrorState,
  LoadingState,
} from "../ui/EmptyState";
import { FileTypeIcon } from "../ui/FileTypeIcon";
import { Dialog, DialogActions } from "../ui/Dialog";
import { Button } from "../ui/Button";
import {
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerHeader,
} from "../ui/Drawer";
import { isTextFile } from "@shared/file-kinds";
import type {
  KnowledgeBaseAsset,
  KnowledgeDocument,
  KnowledgeSearchResult,
} from "@shared/types";

// ============================================================================
// 工具
// ============================================================================

/** 右键菜单尺寸：贴近视口边缘时收拢位置 */
const KB_MENU_HEIGHT = 132;

// ============================================================================
// 页面
// ============================================================================

export function KnowledgeView() {
  const employees = useEmployeesStore((s) => s.employees);
  const loadEmployees = useEmployeesStore((s) => s.load);
  // 知识库目录在启动时已扫描过一次，切换页面直接读缓存
  const { items: bases, loading, error, reload } =
    useAssetCatalog(useKnowledgeBasesStore);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [subPath, setSubPath] = useState("");
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);

  const [query, setQuery] = useState("");
  const [scopeAll, setScopeAll] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | null>(
    null,
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{
    kbId: string;
    relativePath: string;
  } | null>(null);

  /** 知识库右键菜单：同一时间只开一个 */
  const [contextMenu, setContextMenu] = useState<{
    asset: KnowledgeBaseAsset;
    x: number;
    y: number;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadEmployees();
  }, [loadEmployees]);

  // 列表变化后校正选中项：被删则回退到第一个；新建后通过 setSelectedId 选中
  useEffect(() => {
    if (!selectedId && bases.length > 0) {
      setSelectedId(bases[0].id);
      return;
    }
    if (selectedId && !bases.some((asset) => asset.id === selectedId)) {
      setSelectedId(bases[0]?.id ?? null);
    }
  }, [bases, selectedId]);

  // 文档列表：切换知识库 / 目录 / 版本号时重新拉取
  useEffect(() => {
    if (!selectedId) {
      setDocuments([]);
      setSelectedPaths(new Set());
      return;
    }

    let cancelled = false;
    setDocsLoading(true);
    setDocsError(null);
    ipc
      .listKnowledgeDocuments(selectedId, subPath || undefined)
      .then((list) => {
        if (cancelled) return;
        setDocuments(list);
        setSelectedPaths(new Set());
      })
      .catch((err) => {
        if (!cancelled) setDocsError(toMessage(err));
      })
      .finally(() => {
        if (!cancelled) setDocsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId, subPath, version]);

  // 全文检索：防抖 250ms；查询为空时回到文档列表
  useEffect(() => {
    const keyword = query.trim();
    if (!keyword) {
      setSearchResult(null);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const result = await ipc.searchKnowledge(
          keyword,
          scopeAll ? undefined : (selectedId ?? undefined),
        );
        if (!cancelled) setSearchResult(result);
      } catch (err) {
        if (!cancelled) toast.error(toMessage(err), 5000);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, scopeAll, selectedId]);

  // 右键菜单：外部点击 / Esc / 滚动 / 窗口缩放时关闭
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onDown = (event: MouseEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) close();
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
  }, [contextMenu]);

  const selected = bases.find((asset) => asset.id === selectedId) ?? null;
  const searchingNow = query.trim().length > 0;

  const usageCount = useMemo(
    () => countUsage(employees, (employee) => employee.knowledgeBases),
    [employees],
  );

  const crumbs = subPath ? subPath.split("/") : [];
  const allSelected =
    documents.length > 0 &&
    documents.every((document) => selectedPaths.has(document.relativePath));

  const refresh = useCallback(async () => {
    reload();
    setVersion((current) => current + 1);
  }, [reload]);

  const selectBase = (id: string) => {
    setSelectedId(id);
    setSubPath("");
    setQuery("");
    setSearchResult(null);
  };

  /** 把菜单坐标收拢在视口内，并顺带选中被右键的知识库 */
  const openBaseMenu = (
    asset: KnowledgeBaseAsset,
    event: React.MouseEvent,
  ) => {
    event.preventDefault();
    selectBase(asset.id);
    setContextMenu({
      asset,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - KB_MENU_HEIGHT - 8)),
    });
  };

  const handleUpload = async () => {
    if (!selected || uploading) return;
    setUploading(true);
    try {
      const result = await ipc.uploadKnowledgeDocuments(selected.id, subPath);
      if (result.uploaded.length > 0) {
        toast.success(`已上传 ${result.uploaded.length} 个文件`);
      }
      if (!result.ok && result.error) {
        toast.error(result.error, 5000);
      } else if (result.warnings.length > 0) {
        toast.info(result.warnings.join("；"), 6000);
      }
      if (result.uploaded.length > 0) await refresh();
    } catch (err) {
      toast.error(toMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteDocuments = async (paths: string[]) => {
    if (!selected || paths.length === 0) return;
    const label =
      paths.length === 1 ? `「${paths[0]}」` : `选中的 ${paths.length} 项`;
    const confirmed = await confirmDialog({
      title: `删除${label}？`,
      message: "文档会从知识库目录中永久删除，此操作不可恢复。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) return;

    try {
      const ok = await ipc.deleteKnowledgeDocuments(selected.id, paths);
      if (!ok) {
        toast.error("部分条目删除失败，请重试");
      } else {
        toast.success(paths.length === 1 ? "已删除" : `已删除 ${paths.length} 项`);
      }
      setSelectedPaths(new Set());
      await refresh();
    } catch (err) {
      toast.error(toMessage(err));
    }
  };

  const handleDeleteBase = async (asset: KnowledgeBaseAsset) => {
    const users = usageCount.get(asset.id) ?? 0;
    const confirmed = await confirmDialog({
      title: `删除知识库「${asset.name}」？`,
      message: [
        `将删除其中全部 ${asset.documentCount} 个文件（${formatBytes(asset.totalBytes)}）。`,
        users > 0
          ? `有 ${users} 位数字员工正在引用它，删除后这些引用会显示为「已失效」。`
          : "",
        "此操作不可恢复。",
      ]
        .filter(Boolean)
        .join("\n"),
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) return;

    try {
      const ok = await ipc.deleteKnowledgeBase(asset.id);
      if (!ok) {
        toast.error("删除失败，知识库可能已不存在");
        return;
      }
      toast.success("知识库已删除");
      setSubPath("");
      setQuery("");
      reload();
      setVersion((current) => current + 1);
    } catch (err) {
      toast.error(toMessage(err));
    }
  };

  const openFolder = async (asset: KnowledgeBaseAsset) => {
    setContextMenu(null);
    const ok = await ipc.revealKnowledgeBase(asset.id);
    if (!ok) toast.error("无法打开知识库目录");
  };

  return (
    <Page>
        {loading && bases.length === 0 ? (
          <LoadingState text="正在扫描知识库" className="h-full" />
        ) : error && bases.length === 0 ? (
          <ErrorState message={error} onRetry={reload} />
        ) : bases.length === 0 ? (
          <EmptyKnowledge onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* 左：知识库列表 */}
            <ListPane
              title="知识库"
              count={bases.length}
              action={
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  title="新建知识库"
                  aria-label="新建知识库"
                  className="ui-btn-round ui-icon-action flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors active:scale-95"
                >
                  <FolderPlus className="h-4 w-4" />
                </button>
              }
              footer={
                <Button
                  className="w-full"
                  onClick={() => setCreateOpen(true)}
                  icon={<Plus className="h-4 w-4" />}
                >
                  新建知识库
                </Button>
              }
            >
              {bases.map((asset) => (
                <ListItem
                  key={asset.id}
                  active={asset.id === selectedId}
                  icon={<Library className="h-4 w-4" />}
                  title={asset.name}
                  subtitle={asset.description || "暂无简介"}
                  onClick={() => selectBase(asset.id)}
                  onContextMenu={(event) => openBaseMenu(asset, event)}
                  trailing={
                    <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-surface-hover px-1.5 font-mono text-caption leading-none text-text-muted">
                      {asset.documentCount}
                    </span>
                  }
                />
              ))}
            </ListPane>

            {/* 右：当前知识库 */}
            <div className="flex min-w-0 flex-1 flex-col">
              <PageHeader
                title={selected?.name ?? "知识库"}
                icon={<Library className="h-4 w-4" />}
                subtitle={selected?.path}
                badge={
                  selected ? (
                    <>
                      <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 font-mono text-meta text-text-muted">
                        {selected.documentCount} 个 ·{" "}
                        {formatBytes(selected.totalBytes)}
                      </span>
                      {(usageCount.get(selected.id) ?? 0) > 0 && (
                        <span
                          title="启用该知识库的数字员工数"
                          className="flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-meta text-success"
                        >
                          <Users className="h-3 w-3" />
                          {usageCount.get(selected.id)} 位员工
                        </span>
                      )}
                    </>
                  ) : undefined
                }
                actions={
                  <>
                    <Button
                      onClick={() => setFolderOpen(true)}
                      disabled={!selected}
                      icon={<FolderPlus className="h-4 w-4" />}
                    >
                      新建文件夹
                    </Button>
                    <Button
                      variant="primary"
                      onClick={handleUpload}
                      disabled={!selected || uploading}
                      icon={
                        uploading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Upload className="h-4 w-4" />
                        )
                      }
                    >
                      上传文件
                    </Button>
                  </>
                }
              />

              {/* 面包屑 + 检索 */}
              <PageToolbar>
                <div className="flex min-w-0 flex-1 items-center gap-1 text-meta text-text-muted">
                  <button
                    type="button"
                    onClick={() => setSubPath("")}
                    className={`truncate rounded px-1.5 py-0.5 transition-colors hover:bg-surface-hover hover:text-text ${
                      crumbs.length === 0 ? "text-text" : ""
                    }`}
                  >
                    {selected?.name ?? "全部文档"}
                  </button>
                  {crumbs.map((crumb, index) => {
                    const path = crumbs.slice(0, index + 1).join("/");
                    const active = index === crumbs.length - 1;
                    return (
                      <span key={path} className="flex min-w-0 items-center gap-1">
                        <ChevronRight className="h-3 w-3 shrink-0 opacity-60" />
                        <button
                          type="button"
                          onClick={() => setSubPath(path)}
                          className={`truncate rounded px-1.5 py-0.5 transition-colors hover:bg-surface-hover hover:text-text ${
                            active ? "text-text" : ""
                          }`}
                        >
                          {crumb}
                        </button>
                      </span>
                    );
                  })}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setScopeAll((value) => !value)}
                    title={
                      scopeAll
                        ? "当前检索全部知识库，点击切换为仅当前知识库"
                        : "当前仅检索当前知识库，点击切换为全部知识库"
                    }
                    className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-caption transition-colors ${
                      scopeAll
                        ? "border-accent/30 bg-accent-soft font-medium text-accent"
                        : "border-border/60 bg-surface-2/40 text-text-secondary hover:border-border hover:text-text"
                    }`}
                  >
                    <Library className="h-3 w-3" />
                    {scopeAll ? "全部知识库" : "当前知识库"}
                  </button>

                  <SearchInput
                    value={query}
                    onChange={setQuery}
                    placeholder={
                      scopeAll ? "全文搜索全部知识库" : "全文搜索当前知识库"
                    }
                  />

                  <button
                    type="button"
                    onClick={() => void refresh()}
                    title="刷新"
                    aria-label="刷新文档列表"
                    className="ui-btn-round ui-icon-action flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors active:scale-95"
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${docsLoading ? "animate-spin" : ""}`}
                    />
                  </button>
                </div>
              </PageToolbar>

              {/* 文档列表 / 检索结果 */}
              <PageBody>
                {searchingNow ? (
                  <SearchResults
                    searching={searching}
                    result={searchResult}
                    query={query}
                    showKbName={scopeAll}
                    onOpen={(kbId, relativePath) =>
                      setPreview({ kbId, relativePath })
                    }
                  />
                ) : docsLoading ? (
                  <div className="flex h-60 items-center justify-center gap-2 text-body text-text-muted">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在加载文档
                  </div>
                ) : docsError ? (
                  <ErrorState message={docsError} onRetry={refresh} />
                ) : documents.length === 0 ? (
                  <EmptyDocuments
                    onUpload={handleUpload}
                    uploading={uploading}
                  />
                ) : (
                  <div className="overflow-hidden rounded-xl border border-border/70 bg-surface-2/30 shadow-[var(--c-shadow-sm)]">
                    <div className="sticky top-0 z-10 grid grid-cols-[28px_minmax(0,1fr)_90px_130px_36px] items-center gap-3 border-b border-border/70 bg-surface-2/85 px-3.5 py-2.5 text-caption font-semibold text-text-muted backdrop-blur-sm">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={() =>
                          setSelectedPaths(
                            allSelected
                              ? new Set()
                              : new Set(
                                  documents.map((document) => document.relativePath),
                                ),
                          )
                        }
                        title="全选"
                        className="h-3.5 w-3.5"
                        style={{ accentColor: "var(--c-accent)" }}
                      />
                      <span>名称</span>
                      <span className="text-right">大小</span>
                      <span className="text-right">更新时间</span>
                      <span />
                    </div>

                    {documents.map((document) => {
                      const checked = selectedPaths.has(document.relativePath);
                      return (
                        <div
                          key={document.relativePath}
                          className={`group grid grid-cols-[28px_minmax(0,1fr)_90px_130px_36px] items-center gap-3 border-b border-border/40 px-3.5 py-2.5 transition-colors last:border-b-0 ${
                            checked
                              ? "bg-accent-soft/50"
                              : "hover:bg-surface-hover/50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setSelectedPaths((current) => {
                                const next = new Set(current);
                                if (next.has(document.relativePath)) {
                                  next.delete(document.relativePath);
                                } else {
                                  next.add(document.relativePath);
                                }
                                return next;
                              })
                            }
                            title="选择"
                            className="h-3.5 w-3.5"
                            style={{ accentColor: "var(--c-accent)" }}
                          />

                          <button
                            type="button"
                            onClick={() => {
                              if (document.isDirectory) {
                                setSubPath(document.relativePath);
                                setQuery("");
                              } else if (selectedId) {
                                setPreview({
                                  kbId: selectedId,
                                  relativePath: document.relativePath,
                                });
                              }
                            }}
                            className="flex min-w-0 items-center gap-2 text-left"
                          >
                            {document.isDirectory ? (
                              <Folder className="h-4 w-4 shrink-0 text-agent-amber" />
                            ) : (
                              <FileTypeIcon name={document.name} size={16} />
                            )}
                            <span className="truncate text-body text-text">
                              {document.name}
                            </span>
                            {document.isDirectory && (
                              <ChevronRight className="h-3 w-3 shrink-0 text-text-muted" />
                            )}
                            {!document.isDirectory && !document.indexed && (
                              <span
                                title={
                                  isTextFile(document.name)
                                    ? "超过 8MB，未建立全文索引"
                                    : "非文本格式，不建立全文索引"
                                }
                                className="shrink-0 rounded-full bg-agent-amber/10 px-1.5 py-0.5 text-micro text-agent-amber"
                              >
                                未索引
                              </span>
                            )}
                          </button>

                          <span className="text-right font-mono text-meta text-text-muted">
                            {document.isDirectory ? "文件夹" : formatBytes(document.size)}
                          </span>
                          <span className="text-right text-meta text-text-muted">
                            {document.isDirectory
                              ? "—"
                              : formatAssetTime(document.updatedAt)}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              void handleDeleteDocuments([document.relativePath])
                            }
                            title="删除"
                            className="rounded-lg p-1.5 text-text-muted opacity-0 transition-colors hover:bg-error-bg hover:text-error group-hover:opacity-100"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </PageBody>

              {/* 批量操作条 */}
              {selectedPaths.size > 0 && !searchingNow && (
                <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-surface-2/70 px-card py-2">
                  <span className="text-meta text-text-secondary">
                    已选 {selectedPaths.size} 项
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedPaths(new Set())}
                    >
                      取消选择
                    </Button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteDocuments([...selectedPaths])}
                      className="flex items-center gap-1.5 rounded-lg border border-error/25 bg-error-bg px-3 py-1.5 text-meta font-medium text-error transition-colors hover:bg-error/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

      {/* 知识库右键菜单：与工作流的工作区菜单同一套交互 */}
      {contextMenu && (
        <MenuPanel
          x={contextMenu.x}
          y={contextMenu.y}
          menuRef={contextMenuRef}
        >
          <MenuItem
            icon={FolderOpen}
            label="打开知识库目录"
            onClick={() => void openFolder(contextMenu.asset)}
          />
          <MenuItem
            icon={Pencil}
            label="重命名 / 编辑简介"
            onClick={() => {
              const asset = contextMenu.asset;
              setContextMenu(null);
              selectBase(asset.id);
              setEditOpen(true);
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={Trash2}
            label="删除知识库"
            danger
            onClick={() => {
              const asset = contextMenu.asset;
              setContextMenu(null);
              void handleDeleteBase(asset);
            }}
          />
        </MenuPanel>
      )}

      <KnowledgeFormModal
        key={createOpen ? "create-open" : "create-closed"}
        open={createOpen}
        mode="create"
        onClose={() => setCreateOpen(false)}
        onSaved={async (asset) => {
          setCreateOpen(false);
          setSelectedId(asset.id);
          setSubPath("");
          reload();
          setVersion((current) => current + 1);
        }}
      />

      <KnowledgeFormModal
        key={selected ? `edit-${selected.id}` : "edit-none"}
        open={editOpen}
        mode="edit"
        asset={selected}
        onClose={() => setEditOpen(false)}
        onSaved={async () => {
          setEditOpen(false);
          await refresh();
        }}
      />

      <FolderFormModal
        open={folderOpen}
        parentLabel={subPath || (selected?.name ?? "")}
        onClose={() => setFolderOpen(false)}
        onCreated={async () => {
          setFolderOpen(false);
          await refresh();
        }}
        onSubmit={async (name) => {
          if (!selected) return "知识库不存在";
          const ok = await ipc.createKnowledgeFolder(
            selected.id,
            subPath,
            name,
          );
          if (!ok) return "创建失败：名称无效或文件夹已存在";
          toast.success(`文件夹「${name}」已创建`);
          return null;
        }}
      />

      {preview && (
        <KnowledgePreview
          kbId={preview.kbId}
          relativePath={preview.relativePath}
          onClose={() => setPreview(null)}
          onSaved={refresh}
        />
      )}
    </Page>
  );
}

// ============================================================================
// 检索结果
// ============================================================================

function SearchResults({
  searching,
  result,
  query,
  showKbName,
  onOpen,
}: {
  searching: boolean;
  result: KnowledgeSearchResult | null;
  query: string;
  showKbName: boolean;
  onOpen: (kbId: string, relativePath: string) => void;
}) {
  if (searching && !result) {
    return (
      <div className="flex h-60 items-center justify-center gap-2 text-body text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在检索
      </div>
    );
  }

  if (!result || result.hits.length === 0) {
    return (
      <EmptyState
        size="compact"
        icon={<Search />}
        title={`没有找到匹配「${query.trim()}」的内容`}
        description="只检索文本类文件的正文；二进制格式（PDF、Office、图片等）不建立全文索引。"
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 pb-1 text-meta text-text-muted">
        <span>
          找到 {result.total} 条结果
          {result.total >= 50 ? "（最多显示 50 条）" : ""}
        </span>
        {result.degraded && (
          <span
            title="检索词过短，已使用逐字匹配"
            className="rounded-full bg-agent-amber/10 px-2 py-0.5 text-caption text-agent-amber"
          >
            短词匹配
          </span>
        )}
      </div>

      {result.hits.map((hit) => (
        <button
          key={`${hit.kbId}:${hit.relativePath}`}
          type="button"
          onClick={() => onOpen(hit.kbId, hit.relativePath)}
          className="flex w-full items-start gap-3 rounded-xl border border-border bg-surface-2/40 p-3 text-left transition-colors hover:border-border-strong hover:bg-surface-2/70"
        >
          <FileTypeIcon name={hit.relativePath} size={20} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-body-lg font-medium text-text">
                {hit.relativePath.split("/").pop()}
              </span>
              {showKbName && (
                <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-caption text-accent">
                  {hit.kbName}
                </span>
              )}
              <span className="truncate text-caption text-text-muted">
                {hit.relativePath}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-body leading-relaxed text-text-secondary">
              <HighlightedSnippet text={hit.snippet} />
            </p>
          </div>
          <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-text-muted" />
        </button>
      ))}
    </div>
  );
}

/** 把主进程返回的 \u0001 / \u0002 标记渲染为高亮 */
function HighlightedSnippet({ text }: { text: string }) {
  const parts = text.split(/(\u0001|\u0002)/);
  let highlighted = false;

  return (
    <>
      {parts.map((part, index) => {
        if (part === "\u0001") {
          highlighted = true;
          return null;
        }
        if (part === "\u0002") {
          highlighted = false;
          return null;
        }
        return highlighted ? (
          <mark
            key={index}
            className="rounded bg-accent-soft px-0.5 font-medium text-accent"
          >
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        );
      })}
    </>
  );
}

// ============================================================================
// 预览抽屉
// ============================================================================

function KnowledgePreview({
  kbId,
  relativePath,
  onClose,
  onSaved,
}: {
  kbId: string;
  relativePath: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [meta, setMeta] = useState<{ size: number; truncated: boolean } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [saving, setSaving] = useState(false);

  const name = relativePath.split("/").pop() ?? relativePath;
  // 二进制文件没有可读正文：不请求内容，只提示用系统程序打开
  const textual = isTextFile(name);

  useEffect(() => {
    if (!textual) {
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    ipc
      .readKnowledgeDocument(kbId, relativePath)
      .then((document) => {
        if (cancelled) return;
        if (!document) {
          setError("文档不存在或不是文本文件");
          return;
        }
        // 先统一行尾：<textarea> 会把 CRLF 归一化成 LF，
        // 否则用户改回原样后仍会被当成「有改动」
        const normalized = normalizeNewlines(document.content);
        setDraft(normalized);
        setSavedContent(normalized);
        setMeta({ size: document.size, truncated: document.truncated });
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kbId, relativePath, textual]);

  const dirty = !isSameText(draft, savedContent);

  const handleSave = async () => {
    if (saving || !dirty || meta?.truncated) return;
    setSaving(true);
    try {
      const result = await ipc.writeKnowledgeDocument(
        kbId,
        relativePath,
        draft,
      );
      if (!result.ok) {
        toast.error(result.error, 5000);
        return;
      }
      setSavedContent(draft);
      setMeta({ size: result.document.size, truncated: false });
      toast.success(`${name} 已保存`);
      onSaved?.();
    } catch (err) {
      toast.error(toMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer onClose={onClose} ariaLabel={name} width="lg">
      <DrawerHeader>
        <FileTypeIcon name={name} size={20} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-title font-semibold text-text">
            {name}
          </div>
          <div className="truncate font-mono text-caption text-text-muted">
            {relativePath}
            {meta ? ` · ${formatBytes(meta.size)}` : ""}
          </div>
        </div>
        <Button
          size="sm"
          icon={<ExternalLink className="h-3.5 w-3.5" />}
          onClick={async () => {
            const ok = await ipc.openKnowledgeDocument(kbId, relativePath);
            if (!ok) toast.error("无法用系统程序打开该文档");
          }}
          title="用系统程序打开"
        >
          用系统程序打开
        </Button>
        <DrawerCloseButton onClose={onClose} />
      </DrawerHeader>

      <DrawerBody className="flex flex-col">
        {loading ? (
          <div className="flex h-40 items-center justify-center gap-2 text-body text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取文档
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-lg border border-error/40 bg-error-bg p-3 text-body text-error">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : !textual ? (
          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/60 p-3 text-body text-text-secondary">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
            <div>
              这是非文本格式，无法在 Nova 内预览或编辑。请使用右上角「用系统程序打开」查看，
              Agent 运行时仍可直接读取该文件。
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {meta?.truncated && (
              <div className="mb-2 shrink-0 rounded-lg border border-border bg-surface-2/60 p-3 text-meta text-text-muted">
                文档超过 2MB，这里只展示前 2MB 内容，已禁止在 Nova 内保存；
                完整内容请用系统程序打开。
              </div>
            )}
            <EditorBar
              label="文档内容"
              saving={saving}
              disabled={!dirty || !!meta?.truncated}
              onSave={handleSave}
            />
            <CodeTextarea
              value={draft}
              onChange={setDraft}
              readOnly={meta?.truncated}
              minHeightClass="min-h-[420px]"
            />
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}

// ============================================================================
// 新建 / 编辑知识库
// ============================================================================

function KnowledgeFormModal({
  open,
  mode,
  asset,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: "create" | "edit";
  asset?: KnowledgeBaseAsset | null;
  onClose: () => void;
  onSaved: (asset: KnowledgeBaseAsset) => void | Promise<void>;
}) {
  const [name, setName] = useState(asset?.name ?? "");
  const [description, setDescription] = useState(asset?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(asset?.name ?? "");
    setDescription(asset?.description ?? "");
    setError(null);
  }, [open, asset]);

  const handleSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "create"
          ? await ipc.createKnowledgeBase(name, description)
          : asset
            ? await ipc.updateKnowledgeBase(asset.id, name, description)
            : { ok: false as const, error: "知识库不存在" };

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.success(mode === "create" ? "知识库已创建" : "知识库已保存");
      await onSaved(result.asset);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === "create" ? "新建知识库" : "编辑知识库"}
      width="md"
      description={
        <>
          知识库会创建在{" "}
          <code className="font-mono">~/.novastudio/knowledge</code>{" "}
          下，可上传任意格式文件；文本类文件支持全文检索。
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label="名称"
          required
          hint={
            mode === "create"
              ? "用于展示；目录名会保留中文并自动处理非法字符。"
              : "只修改展示名，目录路径保持不变，避免员工引用失效。"
          }
        >
          <TextInput
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleSubmit();
            }}
            placeholder="例如：产品手册"
          />
        </Field>

        <Field label="简介">
          <TextArea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            placeholder="一句话说明这个知识库收录什么资料"
            className="resize-y leading-relaxed"
          />
        </Field>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-error/40 bg-error-bg p-2.5 text-meta text-error">
          {error}
        </p>
      )}

      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="primary"
          onClick={() => void handleSubmit()}
          disabled={!name.trim()}
          loading={busy}
        >
          {mode === "create" ? "创建" : "保存"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ============================================================================
// 新建文件夹
// ============================================================================

function FolderFormModal({
  open,
  parentLabel,
  onClose,
  onSubmit,
  onCreated,
}: {
  open: boolean;
  parentLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<string | null>;
  onCreated: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
    }
  }, [open]);

  const handleCreate = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const message = await onSubmit(name.trim());
      if (message) {
        setError(message);
        return;
      }
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="新建文件夹"
      width="sm"
      description={`创建在「${parentLabel || "知识库根目录"}」下。`}
    >
      <TextInput
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void handleCreate();
        }}
        placeholder="例如：规范"
      />
      {error && <p className="mt-2 text-meta text-error">{error}</p>}

      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="primary"
          onClick={() => void handleCreate()}
          disabled={!name.trim()}
          loading={busy}
        >
          创建
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ============================================================================
// 小件
// ============================================================================

function EmptyKnowledge({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      icon={<Library />}
      title="建立第一个知识库"
      description="创建一个知识库，上传资料文件，然后在数字员工里勾选引用。工作流执行节点时，Agent 会把这些资料当作自己的能力。"
      action={
        <Button
          variant="primary"
          onClick={onCreate}
          icon={<FolderPlus className="h-4 w-4" />}
        >
          新建知识库
        </Button>
      }
    />
  );
}

function EmptyDocuments({
  onUpload,
  uploading,
}: {
  onUpload: () => void;
  uploading: boolean;
}) {
  return (
    <EmptyBlock
      icon={<FileText />}
      title="这个文件夹还没有文件"
      description="支持任意格式，单文件最大 100MB；文本类文件会建立全文索引，同名文件会自动加序号。"
      action={
        <Button
          variant="primary"
          size="sm"
          loading={uploading}
          icon={<Upload className="h-4 w-4" />}
          onClick={onUpload}
        >
          上传文件
        </Button>
      }
    />
  );
}
