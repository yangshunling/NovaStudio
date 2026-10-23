/**
 * 技能资产页
 *
 * 聚合展示三类来源：
 * - Nova 技能库（~/.novastudio/skills）：可导入、编辑、删除
 * - Claude 全局（~/.claude/skills）：只读发现，可被员工引用
 * - 共享技能库（~/.agents/skills）：只读发现，可被员工引用
 *
 * 只读来源不是缺陷，而是边界：它们由各自工具管理，Nova 只做索引与运行时复制，
 * 避免两边同时写导致技能内容互相覆盖。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  AlertTriangle,
  FileText,
  FolderOpen,
  Loader2,
  Lock,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { useSkillFontSize } from "../../hooks/useTheme";
import { toast } from "../../stores/toast";
import {
  formatAssetTime,
  Meta,
  SourceTag,
  Tag,
} from "../assets/assetUi";
import { SKILL_ORIGIN_CLASS, SKILL_ORIGIN_LABEL } from "./presentation";
import type {
  DigitalEmployee,
  SkillAsset,
  SkillDocument,
  SkillImportKind,
  SkillOrigin,
} from "@shared/types";

// ============================================================================
// 常量
// ============================================================================

const FILTERS: ReadonlyArray<{ id: "all" | SkillOrigin; label: string }> = [
  { id: "all", label: "全部" },
  { id: "library", label: "Nova 技能库" },
  { id: "claude-global", label: "Claude 全局" },
  { id: "agents-store", label: "共享技能库" },
];

// ============================================================================
// 页面
// ============================================================================

export function SkillsView() {
  // 技能页整体比全局字号大一档，避免标签 / 路径 / 正文过小
  const skillFontSize = useSkillFontSize();
  const [skills, setSkills] = useState<SkillAsset[]>([]);
  const [employees, setEmployees] = useState<DigitalEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | SkillOrigin>("all");
  const [importing, setImporting] = useState<SkillImportKind | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, staff] = await Promise.all([
        ipc.listSkills(),
        ipc.listEmployees(),
      ]);
      setSkills(list);
      setEmployees(staff);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const usageCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const employee of employees) {
      for (const skill of employee.skills) {
        if (skill.enabled && skill.assetId) {
          map.set(skill.assetId, (map.get(skill.assetId) ?? 0) + 1);
        }
      }
    }
    return map;
  }, [employees]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (filter !== "all" && skill.origin !== filter) return false;
      if (!keyword) return true;
      return [skill.name, skill.slug, skill.description].some((value) =>
        value.toLowerCase().includes(keyword),
      );
    });
  }, [skills, filter, query]);

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
      toast.success(`已导入 ${result.imported.length} 个技能到 Nova 技能库`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(null);
    }
  };

  return (
    <main
      className="relative flex flex-1 flex-col overflow-hidden"
      style={{ "--c-font-size": `${skillFontSize}px` } as CSSProperties}
    >
      <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden rounded-xl">
        {/* 顶栏 */}
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-3 border-b border-border px-card">
          <div className="flex min-w-0 items-center gap-2">
            <span className="ui-serif text-title font-semibold tracking-wide text-text-secondary">
              技能
            </span>
            <span className="rounded-full bg-surface-hover px-2 py-0.5 text-meta font-mono text-text-muted">
              {skills.length} 个
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <div className="ui-ring flex h-9 w-64 items-center gap-1.5 rounded-full bg-input-bg px-3.5">
              <Search className="h-4 w-4 shrink-0 text-text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称 / 描述"
                className="min-w-0 flex-1 bg-transparent text-body text-text placeholder-text-muted outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  title="清除搜索"
                  className="shrink-0 rounded-full p-0.5 text-text-muted transition-colors hover:text-text"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void load();
              }}
              title="重新扫描技能目录"
              className="ui-btn-round flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>

            <button
              type="button"
              onClick={() => handleImport("directory")}
              disabled={importing !== null}
              title="选择包含 SKILL.md 的技能文件夹；选中父目录可批量导入其下的技能"
              className="ui-btn-primary flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-body font-medium disabled:opacity-60"
            >
              {importing === "directory" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              导入技能 SKILL
            </button>
          </div>
        </header>

        {/* 来源过滤 */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-card py-2">
          {FILTERS.map((item) => {
            const count =
              item.id === "all"
                ? skills.length
                : skills.filter((skill) => skill.origin === item.id).length;
            const activeFilter = filter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`rounded-full px-2.5 py-1 text-meta transition-colors ${
                  activeFilter
                    ? "bg-accent-soft font-medium text-accent"
                    : "bg-surface-2/60 text-text-secondary hover:bg-surface-hover hover:text-text"
                }`}
              >
                {item.label}
                <span className="ml-1 opacity-70">{count}</span>
              </button>
            );
          })}
          <span className="ml-auto text-meta text-text-muted">
            只读来源可引用，不可编辑或删除
          </span>
        </div>

        {/* 列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-section">
          {loading ? (
            <div className="flex h-60 items-center justify-center gap-2 text-body text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在扫描技能
            </div>
          ) : error ? (
            <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
              <p className="text-body text-error">{error}</p>
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  void load();
                }}
                className="ui-btn-ghost rounded-lg px-3 py-2 text-body"
              >
                重新加载
              </button>
            </div>
          ) : skills.length === 0 ? (
            <EmptySkills onImport={handleImport} importing={importing} />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center text-text-muted">
              <Search className="h-6 w-6 opacity-50" />
              <p className="text-body">
                {query ? `没有匹配「${query}」的技能` : "该来源下还没有技能"}
              </p>
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="text-body text-accent hover:underline"
                >
                  清除搜索
                </button>
              )}
            </div>
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
        </div>
      </div>

      {active && (
        <SkillDrawer
          skill={active}
          employees={employees}
          onClose={() => setActiveId(null)}
          onChanged={load}
          onDeleted={() => {
            setActiveId(null);
            void load();
          }}
        />
      )}
    </main>
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
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full min-h-36 flex-col rounded-xl border border-border bg-surface-2/60 p-card text-left transition-all hover:-translate-y-0.5 hover:border-border-strong hover:bg-surface-2/85 hover:shadow-[var(--c-shadow-sm)]"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-title font-semibold text-text">{skill.name}</h3>
        </div>
        <SourceTag
          label={SKILL_ORIGIN_LABEL[skill.origin]}
          className={SKILL_ORIGIN_CLASS[skill.origin]}
        />
      </div>

      <p className="mt-2.5 line-clamp-2 text-body-lg leading-relaxed text-text-secondary">
        {skill.description || "暂无描述"}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
        {skill.readOnly && (
          <Tag icon={Lock} title="来源由其他工具管理，Nova 只能引用">
            只读
          </Tag>
        )}
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
        <span className="ml-auto text-meta text-text-muted">
          {formatAssetTime(skill.updatedAt)}
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
  const [document, setDocument] = useState<SkillDocument | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    ipc
      .getSkillDocument(skill.id)
      .then((doc) => {
        if (cancelled) return;
        setDocument(doc);
        setContent(doc?.content ?? "");
      })
      .catch(() => {
        if (!cancelled) setDocument(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skill.id]);

  const usedBy = employees.filter((employee) =>
    employee.skills.some(
      (item) => item.enabled && item.assetId === skill.id,
    ),
  );

  const dirty = document !== null && content !== document.content;

  const handleSave = async () => {
    if (saving || !document || document.readOnly || document.truncated) return;
    setSaving(true);
    try {
      const result = await ipc.saveSkillDocument(skill.id, content);
      if (!result.ok) {
        toast.error(result.error, 5000);
        return;
      }
      setDocument({ ...document, content });
      toast.success("SKILL.md 已保存");
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (skill.readOnly) return;
    const suffix =
      usedBy.length > 0
        ? `\n\n有 ${usedBy.length} 位数字员工正在使用它，删除后这些员工会失去该技能。`
        : "";
    if (!window.confirm(`从 Nova 技能库删除「${skill.name}」？${suffix}`)) return;

    try {
      const ok = await ipc.deleteSkill(skill.id);
      if (!ok) {
        toast.error("删除失败：技能可能已不存在");
        return;
      }
      toast.success("技能已删除");
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose} role="presentation">
      <div className="absolute inset-0 bg-bg/40 backdrop-blur-sm" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="技能详情"
        className="ui-glass-strong relative flex h-full w-[720px] max-w-[94vw] flex-col border-l border-border-strong shadow-[var(--c-shadow)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex h-[var(--c-layout-header)] shrink-0 items-center gap-3 border-b border-border px-card">
          <Sparkles className="h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-title font-semibold text-text">
                {skill.name}
              </span>
              <SourceTag
                label={SKILL_ORIGIN_LABEL[skill.origin]}
                className={SKILL_ORIGIN_CLASS[skill.origin]}
              />
              {skill.readOnly && <Tag icon={Lock}>只读</Tag>}
            </div>
            <div className="truncate text-meta text-text-muted">
              {skill.slug}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-section py-card">
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            {/* 顶部信息固定高度：剩余空间全部留给 SKILL.md */}
            <div className="shrink-0 space-y-4">
            {/* 只读说明：告诉用户为什么不能编辑 / 删除，以及能做什么 */}
            {skill.readOnly && skill.readOnlyReason && (
              <div className="rounded-lg border border-border bg-surface-2/60 p-3">
                <div className="flex items-start gap-2 text-body leading-relaxed text-text-secondary">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
                  <div>
                    <p>{skill.readOnlyReason}</p>
                    <p className="mt-1 text-text-muted">
                      你仍然可以在数字员工中绑定它；Nova 会在每次运行时把技能复制到独立的
                      Agent 配置目录，不会改动原目录。
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* 校验问题 */}
            {skill.problems.length > 0 && (
              <div
                className={`rounded-lg border p-3 ${
                  skill.valid
                    ? "border-border bg-surface-2/60"
                    : "border-error/40 bg-error-bg"
                }`}
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle
                    className={`mt-0.5 h-4 w-4 shrink-0 ${
                      skill.valid ? "text-agent-amber" : "text-error"
                    }`}
                  />
                  <ul className="space-y-0.5 text-body leading-relaxed text-text-secondary">
                    {skill.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* 元信息 */}
            <div className="grid grid-cols-2 gap-3 text-body">
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

            {/* SKILL.md 预览 / 编辑：占满抽屉剩余高度，避免短内容下方留大片空白 */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-1.5 flex shrink-0 items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-meta font-medium text-text-secondary">
                  <FileText className="h-3.5 w-3.5" />
                  SKILL.md
                  {dirty && (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-caption text-accent">
                      未保存
                    </span>
                  )}
                </div>
                {!skill.readOnly && (
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={!dirty || saving || !!document?.truncated}
                    className="ui-btn-primary flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-body font-medium disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    保存
                  </button>
                )}
              </div>

              {loading ? (
                <div className="flex min-h-[240px] flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-input-bg text-body text-text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在读取 SKILL.md
                </div>
              ) : document ? (
                <>
                  {document.truncated && (
                    <p className="mb-1.5 shrink-0 text-meta text-agent-amber">
                      文件超过 1MB，这里只展示前 1MB 内容，已禁止在 Nova 内保存；
                      请直接编辑原文件。
                    </p>
                  )}
                  <textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    readOnly={skill.readOnly || document.truncated}
                    spellCheck={false}
                    className={`ui-ring min-h-[240px] w-full flex-1 resize-none rounded-lg border border-input-border bg-input-bg p-inset font-mono text-body-lg leading-relaxed text-text outline-none ${
                      skill.readOnly || document.truncated
                        ? "opacity-80"
                        : "focus:border-input-border-focus"
                    }`}
                  />
                </>
              ) : (
                <div className="flex min-h-[240px] flex-1 items-center rounded-lg border border-border bg-surface-2/60 p-4 text-body text-text-muted">
                  读取不到 SKILL.md。目录可能已被移动或删除，请返回列表重新扫描。
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-card py-3">
          <div>
            {!skill.readOnly && (
              <button
                type="button"
                onClick={handleDelete}
                className="flex items-center gap-1.5 rounded-lg border border-error/25 bg-error-bg px-3 py-2 text-body font-medium text-error transition-colors hover:bg-error/10"
              >
                <Trash2 className="h-4 w-4" />
                从技能库删除
              </button>
            )}
            {skill.readOnly && (
              <span className="text-meta text-text-muted">
                只读来源：删除请到原目录或对应工具中操作
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={async () => {
              const ok = await ipc.revealSkill(skill.id);
              if (!ok) toast.error("无法打开技能目录，可能已被移动或删除");
            }}
            className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent-soft px-3.5 py-2 text-body font-medium text-accent transition-colors hover:bg-accent/15"
          >
            <FolderOpen className="h-4 w-4" />
            打开目录
          </button>
        </div>
      </div>
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
    <div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-3 py-20 text-center text-text-muted">
      <div className="ui-btn-round flex h-16 w-16 items-center justify-center rounded-2xl">
        <Sparkles className="h-6 w-6" />
      </div>
      <h2 className="ui-serif text-heading font-semibold text-text-secondary">
        管理你的技能资产
      </h2>
      <p className="text-body-lg leading-relaxed">
        把包含 SKILL.md 的技能文件夹导入 Nova 主库，然后在数字员工中勾选绑定。
        Claude 全局与共享技能库会自动扫描，无需重复导入。
      </p>
      <button
        type="button"
        onClick={() => onImport("directory")}
        disabled={importing !== null}
        className="ui-btn-primary mt-2 flex h-8 items-center gap-1.5 rounded-full px-4 text-body font-medium disabled:opacity-60"
      >
        {importing === "directory" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Upload className="h-4 w-4" />
        )}
        导入技能 SKILL
      </button>
    </div>
  );
}
