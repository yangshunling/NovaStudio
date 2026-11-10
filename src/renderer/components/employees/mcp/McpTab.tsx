/**
 * 数字员工 — MCP 绑定标签页
 *
 * 直接展示 MCP 库：未绑定的条目给「添加」，已绑定的条目给启用开关与
 * 「移除」。不再经过「点添加 → 弹窗选择」两步。
 */

import { AlertTriangle, KeyRound, Plug, Upload } from "lucide-react";
import { ipc } from "../../../lib/ipc";
import {
  useAssetCatalog,
  useMcpServersStore,
} from "../../../stores/assets";
import { toast } from "../../../stores/toast";
import { splitArgs } from "@shared/mcp";
import {
  MCP_TRANSPORT_CLASS,
  MCP_TRANSPORT_LABEL,
} from "../../mcp/presentation";
import {
  AssetBindName,
  AssetBindTab,
  BindChip,
} from "../AssetBindTab";
import type {
  EmployeeMcpServer,
  McpServerAsset,
  McpServerDraft,
} from "@shared/types";
import { errorMessage } from "@shared/error";

export function McpTab({
  servers,
  onChange,
}: {
  servers: EmployeeMcpServer[];
  onChange: (servers: EmployeeMcpServer[]) => void;
}) {
  /** MCP 库中的全部资产：既作候选，也用于判断已绑定条目是否仍存在 */
  const { items: catalog, loading, error: loadError, setItems: setCatalog } =
    useAssetCatalog(useMcpServersStore);

  const migrateLegacy = async (binding: EmployeeMcpServer, index: number) => {
    if (binding.assetId) return;

    const rawName = binding.name?.trim() || "mcp";
    const draft: McpServerDraft = {
      name: /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rawName)
        ? rawName
        : `mcp-${index + 1}`,
      description: "",
      transport: "stdio",
      command: binding.command ?? "",
      args: splitArgs(binding.args ?? "").join("\n"),
      env: binding.env ?? "",
      url: "",
      headers: "",
    };

    try {
      const result = await ipc.createMcpServer(draft);
      if (!result.ok) {
        toast.error(result.error, 5000);
        return;
      }
      // 同步到共享缓存，切到 MCP 页时不会出现刚迁移完却看不到的假象
      setCatalog((current) => [...current, result.asset]);

      onChange(
        servers.map((server, i) =>
          i === index
            ? {
                assetId: result.asset.id,
                name: result.asset.name,
                enabled: server.enabled,
              }
            : server,
        ),
      );
      toast.success("已写入 Claude MCP 配置");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <AssetBindTab<McpServerAsset, EmployeeMcpServer>
      intro="直接在下方列表中添加这位员工可调用的服务。服务定义统一在「MCP」页面管理，这里只保存引用；停用的服务不会注入运行时。运行时是否生效取决于工作流节点选择的 Agent，不支持时会忽略并写入运行告警。"
      catalog={catalog}
      loading={loading}
      error={loadError ? `MCP 库加载失败：${loadError}` : null}
      loadingText="正在扫描 MCP 库"
      empty={{
        icon: Plug,
        text: "MCP 库还是空的",
        hint: "请先在「MCP」页面新建或导入服务。",
      }}
      bindings={servers}
      onChange={onChange}
      getAssetId={(asset) => asset.id}
      getBindingAssetId={(binding) => binding.assetId}
      makeBinding={(asset) => ({
        assetId: asset.id,
        name: asset.name,
        enabled: true,
      })}
      toggleLabel="启用 MCP 服务"
      orphanHint="以下绑定来自旧版配置或已从 MCP 库删除："
      renderAssetMeta={(asset) => {
        const problems = asset.valid ? [] : asset.problems;
        return (
          <>
            <AssetBindName name={asset.name}>
              <BindChip className={MCP_TRANSPORT_CLASS[asset.transport]}>
                {MCP_TRANSPORT_LABEL[asset.transport]}
              </BindChip>
              {asset.hasSecrets && (
                <BindChip
                  icon={KeyRound}
                  tone="warn"
                  title="env / headers 中存在字面量密钥"
                >
                  含密钥
                </BindChip>
              )}
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
      renderOrphanMeta={(binding, asset) => {
        const legacy = !binding.assetId;
        const missing = !legacy && !asset;
        return (
          <>
            <AssetBindName name={binding.name}>
              {legacy && <BindChip tone="warn">旧版内联</BindChip>}
              {missing && <BindChip tone="error">已失效</BindChip>}
            </AssetBindName>
            <p
              title={binding.command || undefined}
              className="mt-0.5 truncate ui-type-code text-text-muted"
            >
              {binding.command || "—"}
            </p>
          </>
        );
      }}
      renderOrphanActions={(binding, index) =>
        binding.assetId ? null : (
          <button
            type="button"
            onClick={() => void migrateLegacy(binding, index)}
            title="写入 Claude MCP 配置"
            className="shrink-0 rounded-lg p-2 text-text-muted transition-colors hover:bg-accent-soft hover:text-accent"
          >
            <Upload className="h-4 w-4" />
          </button>
        )
      }
      renderOrphanNote={(binding, asset) => {
        const legacy = !binding.assetId;
        const missing = !legacy && !asset;
        return (
          <>
            {missing && (
              <p className="mt-1.5 ui-type-note leading-relaxed text-error">
                MCP 资产已不存在（可能从未入库或已被删除）。请移除后从 MCP 库重新选择。
              </p>
            )}
            {legacy && (
              <p className="mt-1.5 ui-type-note leading-relaxed text-text-muted">
                旧版内联配置：运行时仍可注入，建议点击右侧按钮迁移到 MCP 库，
                以便统一管理密钥与来源。
              </p>
            )}
          </>
        );
      }}
    />
  );
}
