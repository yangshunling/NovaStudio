/**
 * 技能资产页
 *
 * 只展示 Claude 全局技能（~/.claude/skills）：
 * - Nova 创建的技能可导入、编辑、删除；
 * - 其他工具创建的技能只读，可被员工引用。
 *
 * 只读不是缺陷，而是边界：这些技能由 Claude Code 或其他工具管理，
 * Nova 只做索引与运行时复制，避免两边同时写导致技能内容互相覆盖。
 */

import {
  useEffect,
  useMemo,
  useState,
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
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { useAssetCatalog, useSkillsStore } from "../../stores/assets";
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
import { EmptyState, ErrorState, LoadingState } from "../ui/EmptyState";
import { Page, PageBody, PageHeader } from "../ui/Page";
import { SearchInput } from "../ui/SearchInput";
import {
  CARD_DESCRIPTION,
  CARD_META,
  CARD_SHELL,
  CARD_TITLE,
} from "../ui/cardStyles";
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
} from "@shared/types";

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

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return skills;
    return skills.filter((skill) =>
      [skill.name, skill.slug, skill.description].some((value) =>
        value.toLowerCase().includes(keyword),
      ),
    );
  }, [skills, query]);

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
        actions={
          <>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="搜索名称 / 描述"
            />

            <button
              type="button"
              onClick={reload}
              title="重新扫描技能目录"
              aria-label="重新扫描技能目录"
              className="ui-btn-round ui-icon-action flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>

            <Button
              variant="primary"
              onClick={() => handleImport("directory")}
              disabled={importing !== null}
              title="选择包含 SKILL.md 的技能文件夹；选中父目录可批量导入其下的技能"
              icon={
                importing === "directory" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
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
            <EmptyState
              size="compact"
              icon={<Search />}
              title={`没有匹配「${query}」的技能`}
              action={
                query ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="text-meta text-accent hover:underline"
                  >
                    清除搜索
                  </button>
                ) : undefined
              }
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
    <button
      type="button"
      onClick={onOpen}
      className={CARD_SHELL}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className={CARD_TITLE}>{skill.name}</h3>
        </div>
        <SourceTag
          label={SKILL_ORIGIN_LABEL[skill.origin]}
          className={SKILL_ORIGIN_CLASS[skill.origin]}
        />
      </div>

      <p className={`mt-2.5 ${CARD_DESCRIPTION}`}>
        {skill.description || "暂无描述"}
      </p>

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
      toast.error(toMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (skill.readOnly) return;
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
    <Drawer onClose={onClose} ariaLabel="技能详情" widthClass="w-[720px]">
      {/* 头部 */}
      <DrawerHeader>
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
            </div>
            <div className="truncate text-meta text-text-muted">
              {skill.slug}
            </div>
          </div>
        <DrawerCloseButton onClose={onClose} />
      </DrawerHeader>

      <DrawerBody className="flex flex-col">
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
                      你仍然可以在数字员工中绑定它；Nova
                      会在每次运行时把技能复制到独立的 Agent
                      配置目录，不会改动原目录。
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
                  <Button
                    variant="primary"
                    loading={saving}
                    icon={<Save className="h-4 w-4" />}
                    onClick={handleSave}
                    disabled={!dirty || !!document?.truncated}
                  >
                    保存
                  </Button>
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
      </DrawerBody>

      {/* 底部操作 */}
      <DrawerFooter>
        <div>
          {!skill.readOnly && (
            <Button
              size="sm"
              variant="dangerLink"
              onClick={handleDelete}
              icon={<Trash2 className="h-4 w-4" />}
            >
              从技能库删除
            </Button>
          )}
          {skill.readOnly && (
            <span className="text-meta text-text-muted">
              只读来源：删除请到原目录或对应工具中操作
            </span>
          )}
        </div>
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
