/**
 * 数字员工 — MCP 绑定标签页与选择器
 */

import { useEffect, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  Check,
  KeyRound,
  Loader2,
  Lock,
  Plug,
  Plus,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { ipc } from "../../../lib/ipc";
import { useSkillFontSize } from "../../../hooks/useTheme";
import { toast } from "../../../stores/toast";
import { splitArgs } from "@shared/mcp";
import { Modal, ModalHeader } from "../../ui/Modal";
import {
  MCP_SOURCE_CLASS,
  MCP_SOURCE_LABEL,
  MCP_TRANSPORT_CLASS,
  MCP_TRANSPORT_LABEL,
} from "../../mcp/presentation";
import { EmptyTab, Toggle } from "../ui";
import type {
  EmployeeMcpServer,
  McpServerAsset,
  McpServerDraft,
} from "@shared/types";

export function McpTab({
  servers,
  agentLabel,
  supportsMcp,
  onChange,
}: {
  servers: EmployeeMcpServer[];
  agentLabel: string;
  supportsMcp: boolean;
  onChange: (servers: EmployeeMcpServer[]) => void;
}) {
  const skillFontSize = useSkillFontSize();
  const [catalog, setCatalog] = useState<McpServerAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    ipc
      .listMcpServers()
      .then((list) => {
        if (cancelled) return;
        // 员工只绑定用户级 Claude MCP；项目级配置由具体工作区决定，不跨项目绑定
        setCatalog(
          list.filter(
            (asset) =>
              asset.id.startsWith("claude-global:") &&
              !asset.id.startsWith("claude-global:local:") &&
              !asset.id.startsWith("claude-global:file:"),
          ),
        );
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

  const unsupported = !supportsMcp && servers.some((server) => server.enabled);

  return (
    <div
      className="space-y-3"
      style={{ "--c-font-size": `${skillFontSize}px` } as CSSProperties}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-body leading-relaxed text-text-muted">
          从 MCP 库勾选这位员工可调用的服务。服务定义统一在「MCP」页面管理，
          这里只保存引用；停用的服务不会注入运行时。
        </p>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="ui-btn-primary flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-body font-medium"
        >
          <Plus className="h-4 w-4" />
          添加 MCP
        </button>
      </div>

      {unsupported && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/60 p-3 text-meta leading-relaxed text-text-muted">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-agent-amber" />
          <span>
            当前绑定的 Agent（{agentLabel}）暂未实现 MCP 注入。服务会正常保存，
            但运行工作流时不会生效；目前只有 Claude Code 支持 MCP 注入。
          </span>
        </div>
      )}

      {loadError && (
        <div className="rounded-lg border border-error/40 bg-error-bg p-3 text-meta text-error">
          MCP 库加载失败：{loadError}
        </div>
      )}

      {servers.length === 0 ? (
        <EmptyTab
          icon={Plug}
          text="还没有绑定 MCP 服务"
          hint="从 MCP 库选择后，员工即可调用对应的外部工具。"
        />
      ) : (
        <div className="space-y-2">
          {servers.map((server, index) => {
            const asset = server.assetId ? byId.get(server.assetId) : undefined;
            const legacy = !server.assetId;
            const missing = !legacy && !asset && !loading && !loadError;
            const problems = asset && !asset.valid ? asset.problems : [];
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
                        {asset?.name || server.name}
                      </span>
                      {asset && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${MCP_SOURCE_CLASS[asset.source]}`}
                        >
                          {MCP_SOURCE_LABEL[asset.source]}
                        </span>
                      )}
                      {asset && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${MCP_TRANSPORT_CLASS[asset.transport]}`}
                        >
                          {MCP_TRANSPORT_LABEL[asset.transport]}
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
                      {asset?.hasSecrets && (
                        <span
                          title="env / headers 中存在字面量密钥"
                          className="flex shrink-0 items-center gap-0.5 rounded-full bg-agent-amber/10 px-2 py-0.5 text-caption text-agent-amber"
                        >
                          <KeyRound className="h-2.5 w-2.5" />
                          含密钥
                        </span>
                      )}
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
                      title={asset?.path || server.command || undefined}
                      className="mt-0.5 truncate font-mono text-meta text-text-muted"
                    >
                      {asset ? asset.path : server.command || "—"}
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

      <McpPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        catalog={catalog}
        loading={loading}
        query={query}
        onQueryChange={setQuery}
        boundIds={boundIds}
        onAdd={addAsset}
      />
    </div>
  );
}

// ============================================================================
// MCP 选择器
// ============================================================================

function McpPicker({
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
  catalog: McpServerAsset[];
  loading: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  boundIds: Set<string>;
  onAdd: (asset: McpServerAsset) => void;
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
        <ModalHeader title="从 MCP 库添加" onClose={onClose} className="mb-2" />

        <p className="mb-3 text-meta leading-relaxed text-text-muted">
          只读来源同样可以绑定，运行时会被渲染到独立的 Agent 配置中。
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
              正在扫描 MCP 库
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-body text-text-muted">
              {catalog.length === 0
                ? "MCP 库还是空的，请先在「MCP」页面新建或导入服务。"
                : "没有匹配的 MCP 服务"}
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
                        className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${MCP_SOURCE_CLASS[asset.source]}`}
                      >
                        {MCP_SOURCE_LABEL[asset.source]}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${MCP_TRANSPORT_CLASS[asset.transport]}`}
                      >
                        {MCP_TRANSPORT_LABEL[asset.transport]}
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
                      {asset.hasSecrets && (
                        <span
                          title="env / headers 中存在字面量密钥"
                          className="flex shrink-0 items-center gap-0.5 rounded-full bg-agent-amber/10 px-2 py-0.5 text-caption text-agent-amber"
                        >
                          <KeyRound className="h-2.5 w-2.5" />
                          含密钥
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

