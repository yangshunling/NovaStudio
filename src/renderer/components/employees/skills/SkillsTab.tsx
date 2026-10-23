/**
 * 数字员工 — 技能绑定标签页与选择器
 */

import { useEffect, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  Lock,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { ipc } from "../../../lib/ipc";
import { useSkillFontSize } from "../../../hooks/useTheme";
import { toast } from "../../../stores/toast";
import { Modal, ModalHeader } from "../../ui/Modal";
import { SKILL_ORIGIN_CLASS, SKILL_ORIGIN_LABEL } from "../../skills/presentation";
import { EmptyTab, Toggle } from "../ui";
import type { EmployeeSkill, SkillAsset } from "@shared/types";

export function SkillsTab({
  skills,
  agentLabel,
  supportsSkills,
  onChange,
}: {
  skills: EmployeeSkill[];
  agentLabel: string;
  supportsSkills: boolean;
  onChange: (skills: EmployeeSkill[]) => void;
}) {
  // 技能标签页同样使用放大后的字号，避免来源标签与路径看不清
  const skillFontSize = useSkillFontSize();
  const [catalog, setCatalog] = useState<SkillAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    ipc
      .listSkills()
      .then((list) => {
        if (cancelled) return;
        setCatalog(list);
        setLoadError(null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const byId = new Map(catalog.map((asset) => [asset.id, asset]));
  const boundIds = new Set(skills.map((skill) => skill.assetId).filter(Boolean));

  const toggleSkill = (index: number, enabled: boolean) =>
    onChange(skills.map((skill, i) => (i === index ? { ...skill, enabled } : skill)));

  const removeSkill = (index: number) =>
    onChange(skills.filter((_, i) => i !== index));

  const addSkill = (asset: SkillAsset) => {
    if (boundIds.has(asset.id)) return;
    onChange([...skills, { assetId: asset.id, name: asset.name, enabled: true }]);
  };

  const unsupported = !supportsSkills && skills.some((skill) => skill.enabled);

  return (
    <div
      className="space-y-3"
      style={{ "--c-font-size": `${skillFontSize}px` } as CSSProperties}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-body leading-relaxed text-text-muted">
          从技能库勾选这位员工可使用的技能。技能内容统一在「Skill」页面管理，
          这里只保存引用，修改技能时所有员工同时生效。
        </p>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="ui-btn-primary flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-body font-medium"
        >
          <Plus className="h-3.5 w-3.5" />
          添加技能
        </button>
      </div>

      {unsupported && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/60 p-3 text-meta leading-relaxed text-text-muted">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-agent-amber" />
          <span>
            当前绑定的 Agent（{agentLabel}）暂未实现技能注入。技能会正常保存，
            但运行工作流时不会生效；如需使用技能，请把员工绑定到 Claude Code。
          </span>
        </div>
      )}

      {loadError && (
        <div className="rounded-lg border border-error/40 bg-error-bg p-3 text-meta text-error">
          技能库加载失败：{loadError}
        </div>
      )}

      {skills.length === 0 ? (
        <EmptyTab
          icon={Sparkles}
          text="还没有绑定技能"
          hint="从技能库选择后，员工可以在合适的时候自动调用。"
        />
      ) : (
        <div className="space-y-2">
          {skills.map((skill, index) => {
            const asset = skill.assetId ? byId.get(skill.assetId) : undefined;
            const legacy = !skill.assetId;
            const missing = !legacy && !asset && !loading && !loadError;
            const problems = asset && !asset.valid ? asset.problems : [];
            const key = skill.assetId || skill.source || `skill-${index}`;

            return (
              <div
                key={key}
                className={`rounded-lg border border-border bg-surface-2/40 p-3 ${
                  skill.enabled ? "" : "opacity-65"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={skill.enabled}
                    onChange={(enabled) => toggleSkill(index, enabled)}
                    label="启用技能"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-body-lg font-medium text-text">
                        {asset?.name || skill.name}
                      </span>
                      {asset && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${SKILL_ORIGIN_CLASS[asset.origin]}`}
                        >
                          {SKILL_ORIGIN_LABEL[asset.origin]}
                        </span>
                      )}
                      {asset?.readOnly && (
                        <span
                          title={asset.readOnlyReason ?? "只读来源"}
                          className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface-hover px-2 py-0.5 text-caption text-text-muted"
                        >
                          <Lock className="h-2.5 w-2.5" />
                          只读
                        </span>
                      )}
                      {legacy && (
                        <span className="shrink-0 rounded-full bg-agent-amber/10 px-2 py-0.5 text-caption text-agent-amber">
                          旧版路径
                        </span>
                      )}
                      {missing && (
                        <span className="shrink-0 rounded-full bg-error-bg px-2 py-0.5 text-caption text-error">
                          已失效
                        </span>
                      )}
                      {problems.length > 0 && (
                        <span
                          title={problems.join("\n")}
                          className="flex shrink-0 items-center gap-0.5 rounded-full bg-error-bg px-2 py-0.5 text-caption text-error"
                        >
                          <AlertTriangle className="h-2.5 w-2.5" />
                          需处理
                        </span>
                      )}
                    </div>
                    <p
                      title={asset?.path || skill.source || undefined}
                      className="mt-0.5 truncate font-mono text-meta text-text-muted"
                    >
                      {asset?.path || skill.source || "—"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeSkill(index)}
                    title="从员工中移除"
                    className="shrink-0 rounded-lg p-2 text-text-muted transition-colors hover:bg-error-bg hover:text-error"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {missing && (
                  <p className="mt-1.5 text-meta leading-relaxed text-error">
                    技能资产已不存在（可能从未入库或已被删除）。请移除后从技能库重新选择。
                  </p>
                )}
                {legacy && (
                  <p className="mt-1.5 text-meta leading-relaxed text-text-muted">
                    旧版路径技能：运行时仍按原路径注入，建议移除后从技能库重新绑定，
                    以便统一管理与校验。
                  </p>
                )}
                {problems.length > 0 && (
                  <p className="mt-1.5 text-meta leading-relaxed text-error">
                    {problems.join("；")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <SkillPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        catalog={catalog}
        loading={loading}
        query={query}
        onQueryChange={setQuery}
        boundIds={boundIds}
        onAdd={addSkill}
      />
    </div>
  );
}

// ============================================================================
// 技能选择器
// ============================================================================

function SkillPicker({
  open,
  onClose,
  catalog,
  loading,
  query,
  onQueryChange,
  boundIds,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  catalog: SkillAsset[];
  loading: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  boundIds: Set<string>;
  onAdd: (asset: SkillAsset) => void;
}) {
  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? catalog.filter((asset) =>
        [asset.name, asset.slug, asset.description].some((value) =>
          value.toLowerCase().includes(keyword),
        ),
      )
    : catalog;

  return (
    <Modal open={open} onClose={onClose} widthClass="w-[560px] max-w-[92vw]">
      <div className="flex max-h-[72vh] flex-col p-card">
        <ModalHeader title="从技能库添加" onClose={onClose} className="mb-2" />

        <p className="mb-3 text-meta leading-relaxed text-text-muted">
          只读来源同样可以绑定，运行时会被复制到独立配置目录。
        </p>

        <div className="ui-ring mb-3 flex h-10 items-center gap-1.5 rounded-full bg-input-bg px-3.5">
          <Search className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索名称 / 描述"
            className="min-w-0 flex-1 bg-transparent text-body text-text placeholder-text-muted outline-none"
          />
        </div>

        <div className="ui-scroll min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-body text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在扫描技能库
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-body text-text-muted">
              {catalog.length === 0
                ? "技能库还是空的，请先在「Skill」页面导入技能。"
                : "没有匹配的技能"}
            </div>
          ) : (
            filtered.map((asset) => {
              const bound = boundIds.has(asset.id);
              return (
                <div
                  key={asset.id}
                  className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/40 p-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-body-lg font-medium text-text">
                        {asset.name}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${SKILL_ORIGIN_CLASS[asset.origin]}`}
                      >
                        {SKILL_ORIGIN_LABEL[asset.origin]}
                      </span>
                      {asset.readOnly && (
                        <span
                          title={asset.readOnlyReason ?? "只读来源"}
                          className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface-hover px-2 py-0.5 text-caption text-text-muted"
                        >
                          <Lock className="h-2.5 w-2.5" />
                          只读
                        </span>
                      )}
                      {!asset.valid && (
                        <span className="shrink-0 rounded-full bg-error-bg px-2 py-0.5 text-caption text-error">
                          需处理
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-body leading-relaxed text-text-muted">
                      {asset.description || "暂无描述"}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => onAdd(asset)}
                    disabled={bound}
                    className={`flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-meta font-medium transition-colors ${
                      bound
                        ? "cursor-default bg-success/10 text-success"
                        : "ui-btn-primary"
                    }`}
                  >
                    {bound ? (
                      <>
                        <Check className="h-3 w-3" />
                        已添加
                      </>
                    ) : (
                      <>
                        <Plus className="h-3 w-3" />
                        添加
                      </>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>

      </div>
    </Modal>
  );
}

