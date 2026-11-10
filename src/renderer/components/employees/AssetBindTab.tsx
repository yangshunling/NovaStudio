/**
 * 数字员工资产绑定列表（技能 / MCP / 知识库共用）
 *
 * 三个 Tab 的差异只在「资产元信息长什么样」：
 * 卡片外壳、启用开关、添加 / 移除、空态、加载态、孤儿条目区全部一致。
 * 这里收敛共性，具体字段由 render props 提供。
 */

import { useMemo } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Trash2 } from "lucide-react";
import { Toggle } from "../ui/Toggle";
import { Spinner } from "../ui/Spinner";
import { BindAction, EmptyTab } from "./BindUi";

export type BindChipTone = "muted" | "warn" | "error" | "success";

const CHIP_TONE_CLASS: Record<BindChipTone, string> = {
  muted: "bg-surface-hover text-text-muted",
  warn: "bg-agent-amber/10 text-agent-amber",
  error: "bg-error-bg text-error",
  success: "bg-success/10 text-success",
};

/** 绑定卡片上的状态芯片 */
export function BindChip({
  icon: Icon,
  tone = "muted",
  title,
  className = "",
  children,
}: {
  icon?: LucideIcon;
  tone?: BindChipTone;
  title?: string;
  /** 覆盖 tone（例如 MCP 传输方式的自定义配色） */
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 ui-type-note ${
        className || CHIP_TONE_CLASS[tone]
      }`}
    >
      {Icon && <Icon className="h-2.5 w-2.5" />}
      {children}
    </span>
  );
}

/** 资产名 + 状态芯片的标题行 */
export function AssetBindName({
  name,
  children,
}: {
  name: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="truncate ui-type-item font-medium text-text">{name}</span>
      {children}
    </div>
  );
}

interface AssetBindTabProps<TAsset, TBinding extends { enabled: boolean }> {
  /** 顶部说明 */
  intro: ReactNode;
  /** 可绑定资产（与各资产页共用缓存） */
  catalog: readonly TAsset[];
  loading: boolean;
  error: string | null;
  loadingText: string;
  empty: { icon: LucideIcon; text: string; hint?: string };
  /** 已绑定条目 */
  bindings: readonly TBinding[];
  onChange: (next: TBinding[]) => void;
  getAssetId: (asset: TAsset) => string;
  getBindingAssetId: (binding: TBinding) => string | null | undefined;
  makeBinding: (asset: TAsset) => TBinding;
  toggleLabel: string;
  /** 孤儿条目区标题，例如「以下绑定已失效：」 */
  orphanHint: string;
  renderAssetMeta: (asset: TAsset, binding: TBinding | null) => ReactNode;
  renderAssetNote?: (asset: TAsset, binding: TBinding | null) => ReactNode;
  renderOrphanMeta: (binding: TBinding, asset: TAsset | undefined) => ReactNode;
  renderOrphanNote?: (binding: TBinding, asset: TAsset | undefined) => ReactNode;
  /** 移除按钮以外的额外操作（例如 MCP 的「迁移到库」） */
  renderOrphanActions?: (binding: TBinding, index: number) => ReactNode;
}

const CARD_CLASS =
  "rounded-lg border border-border bg-surface-2/40 p-3";

export function AssetBindTab<TAsset, TBinding extends { enabled: boolean }>({
  intro,
  catalog,
  loading,
  error,
  loadingText,
  empty,
  bindings,
  onChange,
  getAssetId,
  getBindingAssetId,
  makeBinding,
  toggleLabel,
  orphanHint,
  renderAssetMeta,
  renderAssetNote,
  renderOrphanMeta,
  renderOrphanNote,
  renderOrphanActions,
}: AssetBindTabProps<TAsset, TBinding>) {
  const byId = useMemo(
    () => new Map(catalog.map((asset) => [getAssetId(asset), asset])),
    [catalog, getAssetId],
  );
  const boundIds = useMemo(
    () => new Set(bindings.map(getBindingAssetId).filter(Boolean)),
    [bindings, getBindingAssetId],
  );

  const orphanBindings = bindings
    .map((binding, index) => ({ binding, index }))
    .filter(({ binding }) => {
      const id = getBindingAssetId(binding);
      return !id || !byId.has(id);
    });

  const toggle = (index: number, enabled: boolean) =>
    onChange(
      bindings.map((binding, i) =>
        i === index ? ({ ...binding, enabled } as TBinding) : binding,
      ),
    );
  const remove = (index: number) =>
    onChange(bindings.filter((_, i) => i !== index));
  const add = (asset: TAsset) => {
    const id = getAssetId(asset);
    if (boundIds.has(id)) return;
    onChange([...bindings, makeBinding(asset)]);
  };

  return (
    <div className="space-y-3">
      <p className="ui-type-body leading-relaxed text-text-muted">{intro}</p>

      {error && (
        <div className="rounded-lg border border-error/40 bg-error-bg p-3 ui-type-note text-error">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex h-24 items-center justify-center gap-2 ui-type-body text-text-muted">
          <Spinner className="h-4 w-4" />
          {loadingText}
        </div>
      ) : (
        <>
          {catalog.length === 0 ? (
            <EmptyTab icon={empty.icon} text={empty.text} hint={empty.hint} />
          ) : (
            <div className="space-y-2">
              {catalog.map((asset) => {
                const id = getAssetId(asset);
                const index = bindings.findIndex(
                  (binding) => getBindingAssetId(binding) === id,
                );
                const binding = index >= 0 ? bindings[index] : null;

                return (
                  <div
                    key={id}
                    className={`${CARD_CLASS} ${
                      binding && !binding.enabled ? "opacity-65" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {binding && (
                        <Toggle
                          checked={binding.enabled}
                          onChange={(enabled) => toggle(index, enabled)}
                          label={toggleLabel}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        {renderAssetMeta(asset, binding)}
                      </div>
                      <BindAction
                        bound={binding !== null}
                        onAdd={() => add(asset)}
                        onRemove={() => remove(index)}
                      />
                    </div>
                    {renderAssetNote?.(asset, binding)}
                  </div>
                );
              })}
            </div>
          )}

          {orphanBindings.length > 0 && (
            <div className="space-y-2">
              <p className="ui-type-note text-text-muted">{orphanHint}</p>
              {orphanBindings.map(({ binding, index }) => {
                const id = getBindingAssetId(binding);
                const asset = id ? byId.get(id) : undefined;

                return (
                  <div
                    key={id || `orphan-${index}`}
                    className={`${CARD_CLASS} ${
                      binding.enabled ? "" : "opacity-65"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Toggle
                        checked={binding.enabled}
                        onChange={(enabled) => toggle(index, enabled)}
                        label={toggleLabel}
                      />
                      <div className="min-w-0 flex-1">
                        {renderOrphanMeta(binding, asset)}
                      </div>
                      {renderOrphanActions?.(binding, index)}
                      <button
                        type="button"
                        onClick={() => remove(index)}
                        title="从员工中移除"
                        className="shrink-0 rounded-lg p-2 text-text-muted transition-colors hover:bg-error-bg hover:text-error"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    {renderOrphanNote?.(binding, asset)}
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
