/**
 * 技能资产页
 *
 * 只展示 Claude 全局技能（~/.claude/skills）：
 * - 技能可导入、编辑、删除；
 * - 详情左侧列出技能目录下的全部文件，右侧编辑选中文件，
 *   保存时直接写回该文件。
 */

import { useEffect, useMemo, useRef, useState, } from "react";
import {
  AlertTriangle, ChevronRight, FileText, Folder, FolderOpen, RefreshCw, ShieldAlert, Sparkles, Trash2, Upload, Users } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { isSameText, normalizeNewlines, toMessage } from "../../lib/utils";
import { useAssetCatalog, useSkillsStore } from "../../stores/assets";
import { useFilteredList } from "../../hooks/useFilteredList";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import { countUsage, useEmployeesStore } from "../../stores/employees";
import {
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerFooter,
  DrawerHeader,
} from "../ui/Drawer";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import {
  EmptyState,
  ErrorState,
  FilterEmpty,
  LoadingState,
} from "../ui/EmptyState";
import { Page, PageBody, PageHeader } from "../ui/Page";
import { SearchInput } from "../ui/SearchInput";
import {
  CARD_DESCRIPTION,
  CARD_META,
  CARD_SHELL,
  CARD_TITLE,
  cardIconTile,
} from "../ui/cardStyles";
import { formatAssetTime, Meta, Tag } from "../asset/AssetUi";
import { CodeTextarea, EditorBar } from "../asset/EditorUi";
import type {
  DigitalEmployee,
  FileEntry,
  SkillAsset,
  SkillFileDocument,
  SkillImportKind,
} from "@shared/types";
import { Spinner } from "../ui/Spinner";


// ============================================================================
// 页面
// ============================================================================

export function SkillsView() {
  const employees = useEmployeesStore((s) => s.employees);
  const loadEmployees = useEmployeesStore((s) => s.load);
  // 技能目录在启动时已扫描过一次，切换页面直接读缓存
  const { items: skills, loading, error, reload } =
    useAssetCatalog(useSkillsStore);
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState<SkillImportKind | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    void loadEmployees();
  }, [loadEmployees]);

  const usageCount = useMemo(
    () => countUsage(employees, (employee) => employee.skills),
    [employees],
  );

  const filtered = useFilteredList(skills, query, (skill) => [
    skill.name,
    skill.slug,
    skill.description,
  ]);

  const active = skills.find((skill) => skill.id === activeId) ?? null;

  const handleImport = async (kind: SkillImportKind) => {
    if (importing) return;
    setImporting(kind);
    try {
      const result = await ipc.importSkills(kind);
      if (!result.ok) {
        toast.error(result.error ?? "导入失败", 5000);
        return;
      }
      // 用户取消时导入结果为空，不打扰
      if (result.imported.length === 0) return;
      toast.success(
        `已导入 ${result.imported.length} 个技能到 ~/.claude/skills`,
      );
      reload();
    } catch (err) {
      toast.error(toMessage(err));
    } finally {
      setImporting(null);
    }
  };

  return (
    <Page>
      {/* 顶栏 */}
      <PageHeader
        title="技能"
        count={skills.length}
        countSuffix=" 个"
        icon={<Sparkles className="h-4 w-4" />}
        actions={
          <>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="搜索名称 / 描述"
            />

            <IconButton
              icon={<RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />}
              label="重新扫描技能目录"
              onClick={reload}
            />

            <Button
              variant="primary"
              onClick={() => handleImport("directory")}
              disabled={importing !== null}
              title="选择包含 SKILL.md 的技能文件夹；选中父目录可批量导入其下的技能"
              icon={
                importing === "directory" ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <Upload className="h-4 w-4" />
                )
              }
            >
              导入技能 SKILL
            </Button>
          </>
        }
      />

      {/* 列表 */}
      <PageBody>
          {loading && skills.length === 0 ? (
            <LoadingState text="正在扫描技能" />
          ) : error && skills.length === 0 ? (
            <ErrorState message={error} onRetry={reload} />
          ) : skills.length === 0 ? (
            <EmptySkills onImport={handleImport} importing={importing} />
          ) : filtered.length === 0 ? (
            <FilterEmpty
              title={`没有匹配「${query}」的技能`}
              onClear={query ? () => setQuery("") : undefined}
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  usage={usageCount.get(skill.id) ?? 0}
                  onOpen={() => setActiveId(skill.id)}
                />
              ))}
            </div>
          )}
      </PageBody>

      {active && (
        <SkillDrawer
          skill={active}
          employees={employees}
          onClose={() => setActiveId(null)}
          onChanged={async () => reload()}
          onDeleted={() => {
            setActiveId(null);
            reload();
          }}
        />
      )}
    </Page>
  );
}

// ============================================================================
// 卡片
// ============================================================================

function SkillCard({
  skill,
  usage,
  onOpen,
}: {
  skill: SkillAsset;
  usage: number;
  onOpen: () => void;
}) {
  return (
    <button type="button" onClick={onOpen} className={CARD_SHELL}>
      <div className="flex min-w-0 items-start gap-3">
        <span className={cardIconTile("violet")}>
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          {/* 标题 + 目录名：slug 是唯一标识，放开目录里对得上 */}
          <h3 className={CARD_TITLE}>{skill.name}</h3>
          <p className="mt-0.5 truncate ui-type-code-sm text-text-muted">
            {skill.slug}
          </p>
        </div>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
      </div>

      <p className={`mt-2.5 ${CARD_DESCRIPTION}`}>
        {skill.description || "暂无描述"}
      </p>

      {/* 校验问题只放在 tooltip 里等于没提示：把第一条直接写在卡片上 */}
      {!skill.valid && skill.problems.length > 0 && (
        <p
          className="mt-1.5 line-clamp-1 rounded-md bg-error-bg/60 px-2 py-1 ui-type-sub text-error"
          title={skill.problems.join("\n")}
        >
          {skill.problems[0]}
        </p>
      )}

      <div className={CARD_META}>
        {skill.hasScripts && (
          <Tag icon={ShieldAlert} tone="warning" title="技能目录里包含可执行脚本">
            含脚本
          </Tag>
        )}
        {!skill.valid && (
          <Tag icon={AlertTriangle} tone="error" title={skill.problems.join("\n")}>
            需处理
          </Tag>
        )}
        {usage > 0 && (
          <Tag icon={Users} tone="success" title="启用该技能的数字员工数">
            {usage} 位员工
          </Tag>
        )}
        <span className="ml-auto shrink-0 ui-type-sub tabular-nums text-text-muted">
          {skill.fileCount} 个文件 · {formatAssetTime(skill.updatedAt)}
        </span>
      </div>
    </button>
  );
}

// ============================================================================
// 详情抽屉
// ============================================================================

function SkillDrawer({
  skill,
  employees,
  onClose,
  onChanged,
  onDeleted,
}: {
  skill: SkillAsset;
  employees: DigitalEmployee[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesReloadKey, setFilesReloadKey] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [document, setDocument] = useState<SkillFileDocument | null>(null);
  const [content, setContent] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 切换文件时保留未保存的编辑，避免一次误点丢掉内容 */
  const draftsRef = useRef<Record<string, string>>({});

  // 技能目录 → 文件列表；默认展开全部目录并选中 SKILL.md
  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setFilesError(null);
    setExpanded(new Set());
    setActivePath(null);
    setDocument(null);
    setContent("");
    draftsRef.current = {};

    ipc
      .listSkillFiles(skill.id)
      .then((entries) => {
        if (cancelled) return;
        if (!entries) {
          setFiles([]);
          setFilesError("技能不存在，可能已被移动或删除");
          return;
        }
        const list = entries;
        setFiles(list);
        setExpanded(
          new Set(
            list
              .filter((entry) => entry.isDirectory)
              .map((entry) => entry.relativePath),
          ),
        );
        const filesOnly = list.filter((entry) => !entry.isDirectory);
        const preferred =
          filesOnly.find((entry) => entry.relativePath === "SKILL.md") ??
          filesOnly.find(
            (entry) => entry.name.toLowerCase() === "skill.md",
          ) ??
          filesOnly[0];
        setActivePath(preferred?.relativePath ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[skills] listSkillFiles failed", err);
        const message = toMessage(err);
        setFiles([]);
        setFilesError(
          /no handler registered/i.test(message)
            ? "主进程还在运行旧代码：请完全退出 Nova 后重新启动（只刷新页面不够）"
            : message,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [skill.id, filesReloadKey]);

  // 选中文件 → 读取内容（优先恢复未保存的草稿）
  useEffect(() => {
    if (!activePath) {
      setDocument(null);
      setContent("");
      setLoadingFile(false);
      return;
    }

    let cancelled = false;
    setLoadingFile(true);
    setDocument(null);
    ipc
      .readSkillFile(skill.id, activePath)
      .then((doc) => {
        if (cancelled) return;
        const normalized = doc
          ? { ...doc, content: normalizeNewlines(doc.content) }
          : null;
        setDocument(normalized);
        setContent(
          draftsRef.current[activePath] ?? normalized?.content ?? "",
        );
      })
      .catch(() => {
        if (!cancelled) setDocument(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingFile(false);
      });

    return () => {
      cancelled = true;
    };
  }, [skill.id, activePath]);

  const usedBy = employees.filter((employee) =>
    employee.skills.some(
      (item) => item.enabled && item.assetId === skill.id,
    ),
  );

  const tree = useMemo(() => buildSkillTree(files ?? []), [files]);
  const dirty = document !== null && !isSameText(content, document.content);
  const canEdit = !!document && !document.binary && !document.truncated;

  const handleContentChange = (value: string) => {
    setContent(value);
    if (activePath) draftsRef.current[activePath] = value;
  };

  const handleSave = async () => {
    if (saving || !document || !activePath || !canEdit) return;
    setSaving(true);
    try {
      const result = await ipc.writeSkillFile(
        skill.id,
        activePath,
        content,
      );
      if (!result.ok) {
        toast.error(result.error, 5000);
        return;
      }
      setDocument({ ...document, content });
      toast.success(`${activePath} 已保存`);
      await onChanged();
    } catch (err) {
      toast.error(toMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const confirmed = await confirmDialog({
      title: `从 Claude 技能目录删除「${skill.name}」？`,
      message:
        usedBy.length > 0
          ? `有 ${usedBy.length} 位数字员工正在使用它，删除后这些员工会失去该技能。`
          : undefined,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) return;

    try {
      const ok = await ipc.deleteSkill(skill.id);
      if (!ok) {
        toast.error("删除失败：技能可能已不存在");
        return;
      }
      toast.success("技能已删除");
      onDeleted();
    } catch (err) {
      toast.error(toMessage(err));
    }
  };

  return (
    <Drawer
      onClose={onClose}
      ariaLabel="技能详情"
      widthClass="w-[960px]"
    >
      {/* 头部 */}
      <DrawerHeader>
        <Sparkles className="h-5 w-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate ui-type-title text-text">
              {skill.name}
            </span>
          </div>
          <div className="truncate ui-type-note text-text-muted">{skill.slug}</div>
        </div>
        <DrawerCloseButton onClose={onClose} />
      </DrawerHeader>

      <DrawerBody className="flex flex-col">
        {/* 顶部信息：目录 / 更新时间 / 文件数 / 使用情况 */}
        <div className="shrink-0 space-y-4">
          {skill.problems.length > 0 && (
            <div
              className={`rounded-lg border p-3 ${
                skill.valid
                  ? "border-border bg-surface-2/40"
                  : "border-error/40 bg-error-bg"
              }`}
            >
              <div className="flex items-start gap-2">
                <AlertTriangle
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    skill.valid ? "text-agent-amber" : "text-error"
                  }`}
                />
                <ul className="space-y-0.5 ui-type-body leading-relaxed text-text-secondary">
                  {skill.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 ui-type-body">
            <Meta label="目录" value={skill.path} mono />
            <Meta label="最近更新" value={formatAssetTime(skill.updatedAt)} />
            <Meta label="文件数" value={`${skill.fileCount} 个文件`} />
            <Meta
              label="使用情况"
              value={
                usedBy.length > 0
                  ? usedBy.map((employee) => employee.name).join("、")
                  : "尚未被数字员工绑定"
              }
            />
          </div>
        </div>

        {/* 下半部分：左文件树，右文档内容 */}
        <div className="mt-4 flex min-h-0 flex-1 gap-3">
          {/* 左：技能目录下的全部文件 */}
          <aside className="flex w-60 shrink-0 flex-col overflow-hidden rounded-lg border border-border">
            <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
              <span className="ui-type-label text-text-secondary">文件</span>
              <span className="ui-type-code text-text-muted">
                {files ? files.filter((entry) => !entry.isDirectory).length : "—"}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {files === null ? (
                <div className="flex items-center gap-2 px-2 py-3 ui-type-note text-text-muted">
                  <Spinner className="h-3.5 w-3.5" />
                  正在读取目录
                </div>
              ) : filesError ? (
                <div className="px-2 py-3 ui-type-note leading-relaxed text-error">
                  <p>读取目录失败：{filesError}</p>
                  <button
                    type="button"
                    onClick={() => setFilesReloadKey((value) => value + 1)}
                    className="mt-2 rounded-md border border-border px-2 py-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                  >
                    重试
                  </button>
                </div>
              ) : files.length === 0 ? (
                <div className="px-2 py-3 ui-type-note text-text-muted">
                  技能目录为空
                </div>
              ) : (
                <SkillFileTree
                  nodes={tree}
                  depth={0}
                  expanded={expanded}
                  activePath={activePath}
                  onToggle={(path) =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return next;
                    })
                  }
                  onSelect={setActivePath}
                />
              )}
            </div>
          </aside>

          {/* 右：当前文件内容 */}
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <EditorBar
                label={
                  <>
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span
                      className="min-w-0 flex-1 truncate font-mono"
                      title={activePath ?? ""}
                    >
                      {activePath ?? "未选择文件"}
                    </span>
                  </>
                }
                saving={saving}
                disabled={!dirty || !canEdit}
                onSave={handleSave}
                marginClass="mb-0"
              />
            </div>

            <div className="flex min-h-0 flex-1 flex-col p-2">
              {files === null ? (
                <div className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-input-bg ui-type-body text-text-muted">
                  <Spinner className="h-4 w-4" />
                  正在读取技能目录
                </div>
              ) : filesError ? (
                <div className="flex flex-1 items-center justify-center rounded-lg border border-error/40 bg-error-bg p-4 ui-type-body text-error">
                  读取目录失败：{filesError}
                </div>
              ) : !activePath ? (
                <div className="flex flex-1 items-center justify-center rounded-lg border border-border bg-surface-2/40 p-4 ui-type-body text-text-muted">
                  技能目录里还没有文件
                </div>
              ) : loadingFile ? (
                <div className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-input-bg ui-type-body text-text-muted">
                  <Spinner className="h-4 w-4" />
                  正在读取 {activePath}
                </div>
              ) : document?.binary ? (
                <div className="flex flex-1 items-center justify-center rounded-lg border border-border bg-surface-2/40 p-4 ui-type-body text-text-muted">
                  二进制文件，无法在 Nova 中编辑
                </div>
              ) : document ? (
                <>
                  {document.truncated && (
                    <p className="mb-1.5 shrink-0 ui-type-note text-agent-amber">
                      文件超过 1MB，这里只展示前 1MB 内容，已禁止在 Nova 内保存；
                      请直接编辑原文件。
                    </p>
                  )}
                  <CodeTextarea
                    value={content}
                    onChange={handleContentChange}
                    readOnly={document.truncated}
                    minHeightClass="min-h-0"
                  />
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center rounded-lg border border-border bg-surface-2/40 p-4 ui-type-body text-text-muted">
                  读取不到该文件。目录可能已被移动或删除，请返回列表重新扫描。
                </div>
              )}
            </div>
          </section>
        </div>
      </DrawerBody>

      {/* 底部操作 */}
      <DrawerFooter>
        <Button
          size="sm"
          variant="dangerLink"
          onClick={handleDelete}
          icon={<Trash2 className="h-4 w-4" />}
        >
          从技能库删除
        </Button>
        <Button
          size="sm"
          icon={<FolderOpen className="h-4 w-4" />}
          onClick={async () => {
            const ok = await ipc.revealSkill(skill.id);
            if (!ok) toast.error("无法打开技能目录，可能已被移动或删除");
          }}
        >
          打开目录
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// ============================================================================
// 文件树
// ============================================================================

interface SkillTreeNode extends FileEntry {
  children: SkillTreeNode[];
}

/** 把扁平的文件列表拼成目录树；父目录先于子项出现 */
function buildSkillTree(entries: FileEntry[]): SkillTreeNode[] {
  const nodes = new Map<string, SkillTreeNode>();
  const roots: SkillTreeNode[] = [];

  for (const entry of entries) {
    const node: SkillTreeNode = { ...entry, children: [] };
    nodes.set(entry.relativePath, node);

    const slash = entry.relativePath.lastIndexOf("/");
    const parentPath = slash > 0 ? entry.relativePath.slice(0, slash) : "";
    const parent = parentPath ? nodes.get(parentPath) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (list: SkillTreeNode[]) => {
    list.sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name)
        : a.isDirectory
          ? -1
          : 1,
    );
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

function SkillFileTree({
  nodes,
  depth,
  expanded,
  activePath,
  onToggle,
  onSelect,
}: {
  nodes: SkillTreeNode[];
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        const open = expanded.has(node.relativePath);
        const active = activePath === node.relativePath;
        return (
          <div key={node.relativePath}>
            <button
              type="button"
              title={node.relativePath}
              onClick={() =>
                node.isDirectory
                  ? onToggle(node.relativePath)
                  : onSelect(node.relativePath)
              }
              className={`flex min-h-7 w-full items-center gap-1 rounded-md pr-2 text-left ui-type-body transition-colors ${
                active
                  ? "bg-surface-active text-text"
                  : "text-text-secondary hover:bg-surface-hover hover:text-text"
              }`}
              style={{ paddingLeft: 6 + depth * 12 }}
            >
              {node.isDirectory ? (
                <>
                  <ChevronRight
                    className={`h-3 w-3 shrink-0 text-text-muted transition-transform ${
                      open ? "rotate-90" : ""
                    }`}
                  />
                  {open ? (
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
                  )}
                </>
              ) : (
                <FileText className="ml-[18px] h-3.5 w-3.5 shrink-0 text-text-muted" />
              )}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
            </button>

            {node.isDirectory && open && node.children.length > 0 && (
              <SkillFileTree
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                activePath={activePath}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// 小件
// ============================================================================

function EmptySkills({
  onImport,
  importing,
}: {
  onImport: (kind: SkillImportKind) => void;
  importing: SkillImportKind | null;
}) {
  return (
    <EmptyState
      icon={<Sparkles />}
      title="管理你的技能资产"
      description="把包含 SKILL.md 的技能文件夹导入 Claude 全局技能目录（~/.claude/skills），然后在数字员工中勾选绑定。"
      action={
        <Button
          variant="primary"
          onClick={() => onImport("directory")}
          disabled={importing !== null}
          loading={importing === "directory"}
          icon={<Upload className="h-4 w-4" />}
        >
          导入技能 SKILL
        </Button>
      }
    />
  );
}
