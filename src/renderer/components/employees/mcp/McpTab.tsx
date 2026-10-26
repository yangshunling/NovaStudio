/**
 * 数字员工 — MCP 绑定标签页
 *
 * 直接展示 MCP 库：未绑定的条目给「添加」，已绑定的条目给启用开关与
 * 「移除」。不再经过「点添加 → 弹窗选择」两步。
 */

import { useEffect, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Plug,
  Trash2,
  Upload,
} from "lucide-react";
import { ipc } from "../../../lib/ipc";
import { useSkillFontSize } from "../../../hooks/useTheme";
import { toast } from "../../../stores/toast";
import { splitArgs } from "@shared/mcp";
import {
  MCP_SOURCE_CLASS,
  MCP_SOURCE_LABEL,
  MCP_TRANSPORT_CLASS,
  MCP_TRANSPORT_LABEL,
} from "../../mcp/presentation";
import { BindAction, EmptyTab, Toggle } from "../ui";
import type {
  EmployeeMcpServer,
  McpServerAsset,
  McpServerDraft,
} from "@shared/types";

export function McpTab({
  servers,
  onChange,
}: {
  servers: EmployeeMcpServer[];
  onChange: (servers: EmployeeMcpServer[]) => void;
}) {
  const skillFontSize = useSkillFontSize();
  /** MCP 库中的全部资产：既作候选，也用于判断已绑定条目是否仍存在 */
  const [catalog, setCatalog] = useState<McpServerAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipc
      .listMcpServers()
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
  const boundIds = new Set(servers.map((server) => server.assetId).filter(Boolean));

  /** 已绑定但不在库中的条目：旧版内联配置或资产已被删除 */
  const orphanServers = servers
    .map((server, index) => ({ server, index }))
    .filter(({ server }) => !server.assetId || !byId.has(server.assetId));

  const toggleServer = (index: number, enabled: boolean) =>
    onChange(servers.map((server, i) => (i === index ? { ...server, enabled } : server)));

  const removeServer = (index: number) =>
    onChange(servers.filter((_, i) => i !== index));

  const addAsset = (asset: McpServerAsset) => {
    if (boundIds.has(asset.id)) return;
    onChange([...servers, { assetId: asset.id, name: asset.name, enabled: true }]);
  };

  const migrateLegacy = async (index: number) => {
    const legacy = servers[index];
    if (legacy.assetId) return;

    const rawName = legacy.name?.trim() || "mcp";
    const draft: McpServerDraft = {
      name: /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rawName)
        ? rawName
        : `mcp-${index + 1}`,
      description: "",
      transport: "stdio",
      command: legacy.command ?? "",
      args: splitArgs(legacy.args ?? "").join("\n"),
      env: legacy.env ?? "",
      url: "",
      headers: "",
    };

    try {
      const result = await ipc.createMcpServer(draft);
      if (!result.ok) {
        toast.error(result.error, 5000);
        return;
      }
      setCatalog((current) => [...current, result.asset]);
      onChange(
        servers.map((server, i) =>
          i === index
            ? { assetId: result.asset.id, name: result.asset.name, enabled: server.enabled }
            : server,
        ),
      );
      toast.success("已写入 Claude MCP 配置");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="space-y-3"
      style={{ "--c-font-size": `${skillFontSize}px` } as CSSProperties}
    >
      <p className="text-body leading-relaxed text-text-muted">
        直接在下方列表中添加这位员工可调用的服务。服务定义统一在「MCP」页面管理，
        这里只保存引用；停用的服务不会注入运行时。运行时是否生效取决于工作流节点
        选择的 Agent，不支持时会忽略并写入运行告警。
      </p>

      {loadError && (
        <div className="rounded-lg border border-error/40 bg-error-bg p-3 text-meta text-error">
          MCP 库加载失败：{loadError}
        </div>
      )}

      {loading ? (
        <div className="flex h-24 items-center justify-center gap-2 text-body text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在扫描 MCP 库
        </div>
      ) : (
        <>
          {catalog.length === 0 ? (
            <EmptyTab
              icon={Plug}
              text="MCP 库还是空的"
              hint="请先在「MCP」页面新建或导入服务。"
            />
          ) : (
            <div className="space-y-2">
              {catalog.map((asset) => {
                const index = servers.findIndex(
                  (server) => server.assetId === asset.id,
                );
                const binding = index >= 0 ? servers[index] : null;
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
                          onChange={(enabled) => toggleServer(index, enabled)}
                          label="启用 MCP 服务"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-body-lg font-medium text-text">
                            {asset.name}
                          </span>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${MCP_SOURCE_CLASS[asset.source]}`}
                          >
                            {MCP_SOURCE_LABEL[asset.source]}
                          </span>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${MCP_TRANSPORT_CLASS[asset.transport]}`}
                          >
                            {MCP_TRANSPORT_LABEL[asset.transport]}
                          </span>
                          {asset.hasSecrets && (
                            <span
                              title="env / headers 中存在字面量密钥"
                              className="flex shrink-0 items-center gap-0.5 rounded-full bg-agent-amber/10 px-2 py-0.5 text-caption text-agent-amber"
                            >
                              <KeyRound className="h-2.5 w-2.5" />
                              含密钥
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
                          title={asset.path}
                          className="mt-0.5 truncate font-mono text-meta text-text-muted"
                        >
                          {asset.path}
                        </p>
                      </div>
                      <BindAction
                        bound={binding !== null}
                        onAdd={() => addAsset(asset)}
                        onRemove={() => removeServer(index)}
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

          {orphanServers.length > 0 && (
            <div className="space-y-2">
              <p className="text-meta text-text-muted">
                以下绑定来自旧版配置或已从 MCP 库删除：
              </p>
              {orphanServers.map(({ server, index }) => {
                const legacy = !server.assetId;
                const missing = !legacy;
                const key = server.assetId || `legacy-mcp-${index}`;

                return (
                  <div
                    key={key}
                    className={`rounded-lg border border-border bg-surface-2/40 p-3 ${
                      server.enabled ? "" : "opacity-65"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Toggle
                        checked={server.enabled}
                        onChange={(enabled) => toggleServer(index, enabled)}
                        label="启用 MCP 服务"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-body-lg font-medium text-text">
                            {server.name}
                          </span>
                          {legacy && (
                            <span className="shrink-0 rounded-full bg-agent-amber/10 px-2 py-0.5 text-caption text-agent-amber">
                              旧版内联
                            </span>
                          )}
                          {missing && (
                            <span className="shrink-0 rounded-full bg-error-bg px-2 py-0.5 text-caption text-error">
                              已失效
                            </span>
                          )}
                        </div>
                        <p
                          title={server.command || undefined}
                          className="mt-0.5 truncate font-mono text-meta text-text-muted"
                        >
                          {server.command || "—"}
                        </p>
                      </div>
                      {legacy && (
                        <button
                          type="button"
                          onClick={() => migrateLegacy(index)}
                          title="写入 Claude MCP 配置"
                          className="shrink-0 rounded-lg p-2 text-text-muted transition-colors hover:bg-accent-soft hover:text-accent"
                        >
                          <Upload className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeServer(index)}
                        title="从员工中移除"
                        className="shrink-0 rounded-lg p-2 text-text-muted transition-colors hover:bg-error-bg hover:text-error"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>

                    {missing && (
                      <p className="mt-1.5 text-meta leading-relaxed text-error">
                        MCP 资产已不存在（可能从未入库或已被删除）。请移除后从 MCP 库重新选择。
                      </p>
                    )}
                    {legacy && (
                      <p className="mt-1.5 text-meta leading-relaxed text-text-muted">
                        旧版内联配置：运行时仍可注入，建议点击右侧按钮迁移到 MCP 库，
                        以便统一管理密钥与来源。
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
