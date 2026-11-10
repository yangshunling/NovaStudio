/**
 * 数字员工 — 技能绑定标签页
 *
 * 直接展示技能库：未绑定的条目给「添加」，已绑定的条目给启用开关与
 * 「移除」。不再经过「点添加 → 弹窗选择」两步。
 */

import { AlertTriangle, Sparkles } from "lucide-react";
import { useAssetCatalog, useSkillsStore } from "../../../stores/assets";
import {
  AssetBindName,
  AssetBindTab,
  BindChip,
} from "../AssetBindTab";
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

  return (
    <AssetBindTab<SkillAsset, EmployeeSkill>
      intro="直接在下方列表中添加这位员工可使用的技能。技能内容统一在「Skill」页面管理，这里只保存引用，修改技能时所有员工同时生效。运行时是否生效取决于工作流节点选择的 Agent，不支持时会忽略并写入运行告警。"
      catalog={catalog}
      loading={loading}
      error={loadError ? `技能库加载失败：${loadError}` : null}
      loadingText="正在扫描技能库"
      empty={{
        icon: Sparkles,
        text: "技能库还是空的",
        hint: "请先在「Skill」页面导入技能。",
      }}
      bindings={skills}
      onChange={onChange}
      getAssetId={(asset) => asset.id}
      getBindingAssetId={(binding) => binding.assetId}
      makeBinding={(asset) => ({
        assetId: asset.id,
        name: asset.name,
        enabled: true,
      })}
      toggleLabel="启用技能"
      orphanHint="以下绑定来自旧版路径、已删除或不可注入的技能："
      renderAssetMeta={(asset) => {
        const problems = asset.valid ? [] : asset.problems;
        return (
          <>
            <AssetBindName name={asset.name}>
              {problems.length > 0 && (
                <BindChip
                  icon={AlertTriangle}
                  tone="error"
                  title={problems.join("\n")}
                >
                  需处理
                </BindChip>
              )}
            </AssetBindName>
            <p
              title={asset.path}
              className="mt-0.5 truncate ui-type-code text-text-muted"
            >
              {asset.path}
            </p>
          </>
        );
      }}
      renderAssetNote={(asset) => {
        const problems = asset.valid ? [] : asset.problems;
        return problems.length > 0 ? (
          <p className="mt-1.5 ui-type-note leading-relaxed text-error">
            {problems.join("；")}
          </p>
        ) : null;
      }}
      renderOrphanMeta={(skill, asset) => {
        const legacy = !skill.assetId;
        const missing = !legacy && !asset;
        const problems = asset && !asset.valid ? asset.problems : [];
        return (
          <>
            <AssetBindName name={asset?.name || skill.name}>
              {legacy && <BindChip tone="warn">旧版路径</BindChip>}
              {missing && <BindChip tone="error">已失效</BindChip>}
              {problems.length > 0 && (
                <BindChip
                  icon={AlertTriangle}
                  tone="error"
                  title={problems.join("\n")}
                >
                  需处理
                </BindChip>
              )}
            </AssetBindName>
            <p
              title={asset?.path || skill.source || undefined}
              className="mt-0.5 truncate ui-type-code text-text-muted"
            >
              {asset?.path || skill.source || "—"}
            </p>
          </>
        );
      }}
      renderOrphanNote={(skill, asset) => {
        const legacy = !skill.assetId;
        const missing = !legacy && !asset;
        const problems = asset && !asset.valid ? asset.problems : [];
        return (
          <>
            {missing && (
              <p className="mt-1.5 ui-type-note leading-relaxed text-error">
                技能资产已不存在（可能从未入库或已被删除）。请移除后从技能库重新选择。
              </p>
            )}
            {legacy && (
              <p className="mt-1.5 ui-type-note leading-relaxed text-text-muted">
                旧版路径技能：运行时仍按原路径注入，建议移除后从技能库重新绑定，
                以便统一管理与校验。
              </p>
            )}
            {problems.length > 0 && (
              <p className="mt-1.5 ui-type-note leading-relaxed text-error">
                {problems.join("；")}
              </p>
            )}
          </>
        );
      }}
    />
  );
}
