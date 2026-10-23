/**
 * 数字员工 — 知识库绑定标签页与选择器
 *
 * 与 Skill / MCP 标签页同构：员工只存资产引用，文档统一在「知识库」页面管理。
 * 工作流执行节点时，启用的知识库会作为系统提示词的一部分交给 Agent。
 */

import { useEffect, useState, type CSSProperties } from "react";
import {
  Check,
  FileText,
  Library,
  Loader2,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { ipc } from "../../../lib/ipc";
import { useSkillFontSize } from "../../../hooks/useTheme";
import { formatAssetTime } from "../../assets/assetUi";
import { Modal, ModalHeader } from "../../ui/Modal";
import { EmptyTab, Toggle } from "../ui";
import type { EmployeeKnowledge, KnowledgeBaseAsset } from "@shared/types";

export function KnowledgeTab({
  bases,
  onChange,
}: {
  bases: EmployeeKnowledge[];
  onChange: (bases: EmployeeKnowledge[]) => void;
}) {
  const skillFontSize = useSkillFontSize();
  const [catalog, setCatalog] = useState<KnowledgeBaseAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    ipc
      .listKnowledgeBases()
      .then((list) => {
        if (cancelled) return;
        setCatalog(list);
        setLoadError(null);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const byId = new Map(catalog.map((asset) => [asset.id, asset]));
  const boundIds = new Set(bases.map((base) => base.assetId).filter(Boolean));

  const toggleBase = (index: number, enabled: boolean) =>
    onChange(
      bases.map((base, i) => (i === index ? { ...base, enabled } : base)),
    );

  const removeBase = (index: number) =>
    onChange(bases.filter((_, i) => i !== index));

  const addBase = (asset: KnowledgeBaseAsset) => {
    if (boundIds.has(asset.id)) return;
    onChange([
      ...bases,
      { assetId: asset.id, name: asset.name, enabled: true },
    ]);
  };

  return (
    <div
      className="space-y-3"
      style={{ "--c-font-size": `${skillFontSize}px` } as CSSProperties}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-body leading-relaxed text-text-muted">
          从知识库勾选这位员工可引用的 Markdown 资料。知识库统一在「知识库」页面管理，
          这里只保存引用；工作流执行时会作为员工能力的一部分交给 Agent。
        </p>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="ui-btn-primary flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-body font-medium"
        >
          <Plus className="h-3.5 w-3.5" />
          添加知识库
        </button>
      </div>

      {loadError && (
        <div className="rounded-lg border border-error/40 bg-error-bg p-3 text-meta text-error">
          知识库加载失败：{loadError}
        </div>
      )}

      {bases.length === 0 ? (
        <EmptyTab
          icon={Library}
          text="还没有绑定知识库"
          hint="绑定后，员工在执行工作流节点时可以按需读取其中的 Markdown 文档。"
        />
      ) : (
        <div className="space-y-2">
          {bases.map((base, index) => {
            const asset = byId.get(base.assetId);
            const missing = !asset && !loading && !loadError;
            const label = asset?.name || base.name || base.assetId;

            return (
              <div
                key={base.assetId || `knowledge-${index}`}
                className={`rounded-lg border border-border bg-surface-2/40 p-3 ${
                  base.enabled ? "" : "opacity-65"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={base.enabled}
                    onChange={(enabled) => toggleBase(index, enabled)}
                    label="启用知识库"
                  />
                  <span
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
                      base.enabled
                        ? "bg-accent-soft text-accent"
                        : "bg-surface-hover text-text-muted"
                    }`}
                  >
                    <Library className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-body-lg font-medium text-text">
                        {label}
                      </span>
                      {missing && (
                        <span className="shrink-0 rounded-full bg-error-bg px-2 py-0.5 text-caption text-error">
                          已失效
                        </span>
                      )}
                      {asset && (
                        <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-caption text-text-muted">
                          {asset.documentCount} 篇
                        </span>
                      )}
                    </div>
                    <p
                      title={asset?.path}
                      className="mt-0.5 truncate font-mono text-meta text-text-muted"
                    >
                      {asset ? asset.path : "知识库不存在"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeBase(index)}
                    title="从员工中移除"
                    className="shrink-0 rounded-lg p-2 text-text-muted transition-colors hover:bg-error-bg hover:text-error"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {missing && (
                  <p className="mt-1.5 text-meta leading-relaxed text-error">
                    知识库已不存在（可能已被删除）。请移除后从知识库列表重新选择。
                  </p>
                )}
                {asset && asset.documentCount === 0 && (
                  <p className="mt-1.5 text-meta leading-relaxed text-text-muted">
                    这个知识库还没有文档，运行时会自动跳过。
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <KnowledgePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        catalog={catalog}
        loading={loading}
        query={query}
        onQueryChange={setQuery}
        boundIds={boundIds}
        onAdd={addBase}
      />
    </div>
  );
}

// ============================================================================
// 知识库选择器
// ============================================================================

function KnowledgePicker({
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
  catalog: KnowledgeBaseAsset[];
  loading: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  boundIds: Set<string>;
  onAdd: (asset: KnowledgeBaseAsset) => void;
}) {
  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? catalog.filter((asset) =>
        [asset.name, asset.description].some((value) =>
          value.toLowerCase().includes(keyword),
        ),
      )
    : catalog;

  return (
    <Modal open={open} onClose={onClose} widthClass="w-[560px] max-w-[92vw]">
      <div className="flex max-h-[72vh] flex-col p-card">
        <ModalHeader title="从知识库添加" onClose={onClose} className="mb-2" />

        <p className="mb-3 text-meta leading-relaxed text-text-muted">
          只引用 Markdown 文档。启用的知识库会在工作流节点执行前写入 Agent 的系统提示词。
        </p>

        <div className="ui-ring mb-3 flex h-10 items-center gap-1.5 rounded-full bg-input-bg px-3.5">
          <Search className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索知识库名称 / 简介"
            className="min-w-0 flex-1 bg-transparent text-body text-text placeholder-text-muted outline-none"
          />
        </div>

        <div className="ui-scroll min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-body text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在扫描知识库
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-body text-text-muted">
              {catalog.length === 0
                ? "知识库还是空的，请先在「知识库」页面创建并上传 Markdown 文档。"
                : "没有匹配的知识库"}
            </div>
          ) : (
            filtered.map((asset) => {
              const bound = boundIds.has(asset.id);
              return (
                <div
                  key={asset.id}
                  className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/40 p-2.5"
                >
                  <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                    <Library className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-body-lg font-medium text-text">
                        {asset.name}
                      </span>
                      <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface-hover px-2 py-0.5 text-caption text-text-muted">
                        <FileText className="h-2.5 w-2.5" />
                        {asset.documentCount}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-body leading-relaxed text-text-muted">
                      {asset.description || "暂无简介"}
                    </p>
                    <p className="mt-0.5 text-caption text-text-muted">
                      更新于 {formatAssetTime(asset.updatedAt)}
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
