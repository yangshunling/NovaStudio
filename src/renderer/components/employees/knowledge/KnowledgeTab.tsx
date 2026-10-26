/**
 * 数字员工 — 知识库绑定标签页
 *
 * 与 Skill / MCP 标签页同构：员工只存资产引用，文档统一在「知识库」页面管理。
 * 列表直接展示全部知识库，未绑定的给「添加」，已绑定的给启用开关与「移除」。
 * 工作流执行节点时，启用的知识库会作为系统提示词的一部分交给 Agent。
 */

import { useEffect, useState, type CSSProperties } from "react";
import { FileText, Library, Loader2, Trash2 } from "lucide-react";
import { ipc } from "../../../lib/ipc";
import { useSkillFontSize } from "../../../hooks/useTheme";
import { BindAction, EmptyTab, Toggle } from "../ui";
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

  /** 已绑定但知识库已不存在 */
  const orphanBases = bases
    .map((base, index) => ({ base, index }))
    .filter(({ base }) => !byId.has(base.assetId));

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
      <p className="text-body leading-relaxed text-text-muted">
        直接在下方列表中添加这位员工可引用的 Markdown 资料。知识库统一在「知识库」页面
        管理，这里只保存引用；工作流执行时会作为员工能力的一部分交给 Agent。
      </p>

      {loadError && (
        <div className="rounded-lg border border-error/40 bg-error-bg p-3 text-meta text-error">
          知识库加载失败：{loadError}
        </div>
      )}

      {loading ? (
        <div className="flex h-24 items-center justify-center gap-2 text-body text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在扫描知识库
        </div>
      ) : (
        <>
          {catalog.length === 0 ? (
            <EmptyTab
              icon={Library}
              text="知识库还是空的"
              hint="请先在「知识库」页面创建并上传 Markdown 文档。"
            />
          ) : (
            <div className="space-y-2">
              {catalog.map((asset) => {
                const index = bases.findIndex(
                  (base) => base.assetId === asset.id,
                );
                const binding = index >= 0 ? bases[index] : null;

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
                          onChange={(enabled) => toggleBase(index, enabled)}
                          label="启用知识库"
                        />
                      )}
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
                        <p
                          title={asset.path}
                          className="mt-0.5 line-clamp-2 text-body leading-relaxed text-text-muted"
                        >
                          {asset.description || "暂无简介"}
                        </p>
                      </div>
                      <BindAction
                        bound={binding !== null}
                        onAdd={() => addBase(asset)}
                        onRemove={() => removeBase(index)}
                      />
                    </div>
                    {asset.documentCount === 0 && (
                      <p className="mt-1.5 text-meta leading-relaxed text-text-muted">
                        这个知识库还没有文档，运行时会自动跳过。
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {orphanBases.length > 0 && (
            <div className="space-y-2">
              <p className="text-meta text-text-muted">
                以下绑定已失效（知识库已不存在）：
              </p>
              {orphanBases.map(({ base, index }) => (
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
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-body-lg font-medium text-text">
                          {base.name || base.assetId}
                        </span>
                        <span className="shrink-0 rounded-full bg-error-bg px-2 py-0.5 text-caption text-error">
                          已失效
                        </span>
                      </div>
                      <p className="mt-0.5 truncate font-mono text-meta text-text-muted">
                        知识库不存在
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
                  <p className="mt-1.5 text-meta leading-relaxed text-error">
                    知识库已不存在（可能已被删除）。请移除后从知识库列表重新选择。
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
