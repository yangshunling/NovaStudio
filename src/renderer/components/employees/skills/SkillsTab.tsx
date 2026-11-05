/**
 * 数字员工 — 技能绑定标签页
 *
 * 直接展示技能库：未绑定的条目给「添加」，已绑定的条目给启用开关与
 * 「移除」。不再经过「点添加 → 弹窗选择」两步。
 */

import { useMemo } from "react";
import {
  AlertTriangle,
  Loader2,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useAssetCatalog, useSkillsStore } from "../../../stores/assets";
import { Toggle } from "../../ui/Toggle";
import { BindAction, EmptyTab } from "../BindUi";
import type { EmployeeSkill, SkillAsset } from "@shared/types";

export function SkillsTab({
  skills,
  onChange,
}: {
  skills: EmployeeSkill[];
  onChange: (skills: EmployeeSkill[]) => void;
}) {
  /** 可添加到员工的候选：Claude 全局技能（与技能页共用同一份缓存） */
  const { items: catalog, loading, error: loadError } =
    useAssetCatalog(useSkillsStore);
  /** 全部已发现资产：用于判断已绑定条目到底是「不存在」还是「不可绑定」 */
  const assetsById = useMemo(
    () => new Map(catalog.map((asset) => [asset.id, asset])),
    [catalog],
  );

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
    <div className="space-y-3">
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
                          {problems.length > 0 && (
                            <span
                              title={problems.join("\n")}
                              className="flex shrink-0 items-center gap-0.5 rounded-full bg-error-bg px-2 py-0.5 text-meta text-error"
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
                          {legacy && (
                            <span className="shrink-0 rounded-full bg-agent-amber/10 px-2 py-0.5 text-meta text-agent-amber">
                              旧版路径
                            </span>
                          )}
                          {missing && (
                            <span className="shrink-0 rounded-full bg-error-bg px-2 py-0.5 text-meta text-error">
                              已失效
                            </span>
                          )}
                          {problems.length > 0 && (
                            <span
                              title={problems.join("\n")}
                              className="flex shrink-0 items-center gap-0.5 rounded-full bg-error-bg px-2 py-0.5 text-meta text-error"
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
        </>
      )}
    </div>
  );
}
