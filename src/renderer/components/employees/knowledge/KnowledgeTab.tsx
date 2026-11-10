/**
 * 数字员工 — 知识库绑定标签页
 *
 * 与 Skill / MCP 标签页同构：员工只存资产引用，文档统一在「知识库」页面管理。
 * 列表直接展示全部知识库，未绑定的给「添加」，已绑定的给启用开关与「移除」。
 * 工作流执行节点时，启用的知识库会作为系统提示词的一部分交给 Agent。
 */

import { FileText, Library } from "lucide-react";
import {
  useAssetCatalog,
  useKnowledgeBasesStore,
} from "../../../stores/assets";
import {
  AssetBindName,
  AssetBindTab,
  BindChip,
} from "../AssetBindTab";
import type { EmployeeKnowledge, KnowledgeBaseAsset } from "@shared/types";

export function KnowledgeTab({
  bases,
  onChange,
}: {
  bases: EmployeeKnowledge[];
  onChange: (bases: EmployeeKnowledge[]) => void;
}) {
  /** 与知识库页共用同一份缓存，打开员工抽屉不会再次扫描目录 */
  const { items: catalog, loading, error: loadError } =
    useAssetCatalog(useKnowledgeBasesStore);

  return (
    <AssetBindTab<KnowledgeBaseAsset, EmployeeKnowledge>
      intro="直接在下方列表中添加这位员工可引用的 Markdown 资料。知识库统一在「知识库」页面管理，这里只保存引用；工作流执行时会作为员工能力的一部分交给 Agent。"
      catalog={catalog}
      loading={loading}
      error={loadError ? `知识库加载失败：${loadError}` : null}
      loadingText="正在扫描知识库"
      empty={{
        icon: Library,
        text: "知识库还是空的",
        hint: "请先在「知识库」页面创建并上传 Markdown 文档。",
      }}
      bindings={bases}
      onChange={onChange}
      getAssetId={(asset) => asset.id}
      getBindingAssetId={(binding) => binding.assetId}
      makeBinding={(asset) => ({
        assetId: asset.id,
        name: asset.name,
        enabled: true,
      })}
      toggleLabel="启用知识库"
      orphanHint="以下绑定已失效（知识库已不存在）："
      renderAssetMeta={(asset) => (
        <>
          <AssetBindName name={asset.name}>
            <BindChip icon={FileText}>{asset.documentCount}</BindChip>
          </AssetBindName>
          <p
            title={asset.path}
            className="mt-0.5 line-clamp-2 ui-type-body leading-relaxed text-text-muted"
          >
            {asset.description || "暂无简介"}
          </p>
        </>
      )}
      renderAssetNote={(asset) =>
        asset.documentCount === 0 ? (
          <p className="mt-1.5 ui-type-note leading-relaxed text-text-muted">
            这个知识库还没有文档，运行时会自动跳过。
          </p>
        ) : null
      }
      renderOrphanMeta={(binding) => (
        <>
          <AssetBindName name={binding.name || binding.assetId}>
            <BindChip tone="error">已失效</BindChip>
          </AssetBindName>
          <p className="mt-0.5 truncate ui-type-code text-text-muted">
            知识库不存在
          </p>
        </>
      )}
      renderOrphanNote={() => (
        <p className="mt-1.5 ui-type-note leading-relaxed text-error">
          知识库已不存在（可能已被删除）。请移除后从知识库列表重新选择。
        </p>
      )}
    />
  );
}
