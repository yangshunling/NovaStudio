/**
 * 数字员工 — 技能绑定标签页
 *
 * 直接展示技能库：未绑定的条目给「添加」，已绑定的条目给启用开关与
 * 「移除」。不再经过「点添加 → 弹窗选择」两步。
 */

import { useEffect, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  Loader2,
  Sparkles,
  Trash2,
} from "lucide-react";
import { ipc } from "../../../lib/ipc";
import { useSkillFontSize } from "../../../hooks/useTheme";
import { SKILL_ORIGIN_CLASS, SKILL_ORIGIN_LABEL } from "../../skills/presentation";
import { BindAction, EmptyTab, Toggle } from "../ui";
import type { EmployeeSkill, SkillAsset } from "@shared/types";

/**
 * 员工只能绑定 Claude 全局技能（~/.claude/skills）。
 *
 * 共享技能库（~/.agents/skills）只做只读发现，运行时不会被复制进
 * 员工的独立配置目录，因此不进入候选列表。
 */
function isEmployeeBindable(asset: SkillAsset): boolean {
  return asset.origin === "claude-global";
}

export function SkillsTab({
  skills,
  onChange,
}: {
  skills: EmployeeSkill[];
  onChange: (skills: EmployeeSkill[]) => void;
}) {
  // 技能标签页同样使用放大后的字号，避免来源标签与路径看不清
  const skillFontSize = useSkillFontSize();
  /** 可添加到员工的候选：仅 Claude 全局技能 */
  const [catalog, setCatalog] = useState<SkillAsset[]>([]);
  /** 全部已发现资产：用于判断已绑定条目到底是「不存在」还是「不可绑定」 */
  const [assetsById, setAssetsById] = useState<Map<string, SkillAsset>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipc
      .listSkills()
      .then((list) => {
        if (cancelled) return;
        setCatalog(list.filter(isEmployeeBindable));
        setAssetsById(new Map(list.map((asset) => [asset.id, asset])));
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

  const catalogIds = new Set(catalog.map((asset) => asset.id));
  const boundIds = new Set(skills.map((skill) => skill.assetId).filter(Boolean));

  /** 已绑定但不能从列表重新绑定的条目：旧版路径 / 已删除 / 不可注入 */
  const orphanSkills = skills
    .map((skill, index) => ({ skill, index }))
    .filter(({ skill }) => !skill.assetId || !catalogIds.has(skill.assetId));

  const toggleSkill = (index: number, enabled: boolean) =>
    onChange(skills.map((skill, i) => (i === index ? { ...skill, enabled } : skill)));

  const removeSkill = (index: number) =>
    onChange(skills.filter((_, i) => i !== index));

  const addSkill = (asset: SkillAsset) => {
    if (boundIds.has(asset.id)) return;
    onChange([...skills, { assetId: asset.id, name: asset.name, enabled: true }]);
  };

  return (
    <div
      className="space-y-3"
      style={{ "--c-font-size": `${skillFontSize}px` } as CSSProperties}
    >
      <p className="text-body leading-relaxed text-text-muted">
        直接在下方列表中添加这位员工可使用的技能。技能内容统一在「Skill」页面管理，
        这里只保存引用，修改技能时所有员工同时生效。运行时是否生效取决于工作流节点
        选择的 Agent，不支持时会忽略并写入运行告警。
      </p>

      {loadError && (
        <div className="rounded-lg border border-error/40 bg-error-bg p-3 text-meta text-error">
          技能库加载失败：{loadError}
        </div>
      )}

      {loading ? (
        <div className="flex h-24 items-center justify-center gap-2 text-body text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在扫描技能库
        </div>
      ) : (
        <>
          {catalog.length === 0 ? (
            <EmptyTab
              icon={Sparkles}
              text="技能库还是空的"
              hint="请先在「Skill」页面导入技能。"
            />
          ) : (
            <div className="space-y-2">
              {catalog.map((asset) => {
                const index = skills.findIndex(
                  (skill) => skill.assetId === asset.id,
                );
                const binding = index >= 0 ? skills[index] : null;
                const problems = asset.valid ? [] : asset.problems;

                return (
                  <div
                    key={asset.id}
                    className={`rounded-lg border border-border bg-surface-2/40 p-3 ${
                      binding && !binding.enabled ? "opacity-65" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {binding && (
                        <Toggle
                          checked={binding.enabled}
                          onChange={(enabled) => toggleSkill(index, enabled)}
                          label="启用技能"
                        />
                      )}
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
                          title={asset.path}
                          className="mt-0.5 truncate font-mono text-meta text-text-muted"
                        >
                          {asset.path}
                        </p>
                      </div>
                      <BindAction
                        bound={binding !== null}
                        onAdd={() => addSkill(asset)}
                        onRemove={() => removeSkill(index)}
                      />
                    </div>
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

          {orphanSkills.length > 0 && (
            <div className="space-y-2">
              <p className="text-meta text-text-muted">
                以下绑定来自旧版路径、已删除或不可注入的技能：
              </p>
              {orphanSkills.map(({ skill, index }) => {
                const asset = skill.assetId
                  ? assetsById.get(skill.assetId)
                  : undefined;
                const legacy = !skill.assetId;
                const missing = !legacy && !asset;
                const ineligible = !!asset && !isEmployeeBindable(asset);
                const problems = asset && !asset.valid ? asset.problems : [];
                const key =
                  skill.assetId || skill.source || `skill-${index}`;

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
                          {ineligible && (
                            <span
                              title="共享技能库中的技能不会被注入到员工运行时"
                              className="shrink-0 rounded-full bg-agent-amber/10 px-2 py-0.5 text-caption text-agent-amber"
                            >
                              不可注入
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
                    {ineligible && (
                      <p className="mt-1.5 text-meta leading-relaxed text-agent-amber">
                        该技能来自共享技能库（~/.agents/skills），员工运行时只注入
                        ~/.claude/skills 下的技能。请先在「Skill」页面导入到 Claude
                        全局技能库，再重新绑定。
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
        </>
      )}
    </div>
  );
}
