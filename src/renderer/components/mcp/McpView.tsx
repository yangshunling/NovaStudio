/**
 * MCP 资产页
 *
 * MCP 定义统一存放在 Claude 配置中：Nova 创建的条目可编辑，Claude 原有条目只读。
 * 差异在于 MCP 编辑的是服务定义（命令 / 参数 / env / URL / headers），
 * 运行时由 Nova 渲染成目标 Agent 的配置，而不是复制目录。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  AlertTriangle,
  FileJson,
  FolderOpen,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { dirName } from "../../lib/utils";
import { useSkillFontSize } from "../../hooks/useTheme";
import { toast } from "../../stores/toast";
import { assetToDraft } from "@shared/mcp";
import { formatAssetTime, Meta, SourceTag, Tag } from "../assets/assetUi";
import { Field, FORM_INPUT_CLASS as INPUT_CLASS } from "../ui/Field";
import { Modal, ModalHeader } from "../ui/Modal";
import { Select } from "../ui/Select";
import {
  MCP_SOURCE_CLASS,
  MCP_SOURCE_LABEL,
  MCP_TRANSPORT_CLASS,
  MCP_TRANSPORT_LABEL,
} from "./presentation";
import type {
  DigitalEmployee,
  McpServerAsset,
  McpServerDraft,
  McpSource,
  McpTransport,
} from "@shared/types";

// ============================================================================
// 常量
// ============================================================================

const FILTERS: ReadonlyArray<{ id: "all" | McpSource; label: string }> = [
  { id: "all", label: "全部" },
  { id: "claude-global", label: "Claude 配置" },
];

function emptyDraft(): McpServerDraft {
  return {
    name: "",
    description: "",
    transport: "stdio",
    command: "",
    args: "",
    env: "",
    url: "",
    headers: "",
  };
}

function assetToJson(asset: McpServerAsset): string {
  const base = {
    name: asset.name,
    description: asset.description,
    transport: asset.transport,
    ...(asset.transport === "stdio"
      ? { command: asset.command, args: asset.args, env: asset.env }
      : { url: asset.url, headers: asset.headers }),
  };
  return JSON.stringify(base, null, 2);
}

// ============================================================================
// 页面
// ============================================================================

export function McpView() {
  const skillFontSize = useSkillFontSize();
  const [servers, setServers] = useState<McpServerAsset[]>([]);
  const [employees, setEmployees] = useState<DigitalEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | McpSource>("all");
  const [drawer, setDrawer] = useState<
    { mode: "create" } | { mode: "view"; id: string } | null
  >(null);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, staff] = await Promise.all([
        ipc.listMcpServers(),
        ipc.listEmployees(),
      ]);
      setServers(list);
      setEmployees(staff);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const usageCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const employee of employees) {
      for (const server of employee.mcpServers) {
        if (server.enabled && server.assetId) {
          map.set(server.assetId, (map.get(server.assetId) ?? 0) + 1);
        }
      }
    }
    return map;
  }, [employees]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return servers.filter((server) => {
      if (filter !== "all" && server.source !== filter) return false;
      if (!keyword) return true;
      return [server.name, server.slug, server.description].some((value) =>
        value.toLowerCase().includes(keyword),
      );
    });
  }, [servers, filter, query]);

  const active =
    drawer?.mode === "view"
      ? servers.find((server) => server.id === drawer.id) ?? null
      : null;

  return (
    <main
      className="relative flex flex-1 flex-col overflow-hidden"
      style={{ "--c-font-size": `${skillFontSize}px` } as CSSProperties}
    >
      <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden rounded-xl">
        {/* 顶栏 */}
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-3 border-b border-border px-card">
          <div className="flex min-w-0 items-center gap-2">
            <span className="ui-serif text-title font-semibold tracking-wide text-text-secondary">
              MCP
            </span>
            <span className="rounded-full bg-surface-hover px-2 py-0.5 text-meta font-mono text-text-muted">
              {servers.length} 个服务
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <div className="ui-ring flex h-9 w-64 items-center gap-1.5 rounded-full bg-input-bg px-3.5">
              <Search className="h-4 w-4 shrink-0 text-text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称 / 描述"
                className="min-w-0 flex-1 bg-transparent text-body text-text placeholder-text-muted outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  title="清除搜索"
                  className="shrink-0 rounded-full p-0.5 text-text-muted transition-colors hover:text-text"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void load();
              }}
              title="重新扫描 MCP 配置"
              className="ui-btn-round ui-icon-action flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>

            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="ui-btn-ghost flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-body font-medium"
            >
              <Upload className="h-4 w-4" />
              导入
            </button>

            <button
              type="button"
              onClick={() => setDrawer({ mode: "create" })}
              className="ui-btn-primary flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-body font-medium"
            >
              <Plus className="h-4 w-4" />
              新建 MCP
            </button>
          </div>
        </header>

        {/* 来源过滤 */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-card py-2">
          {FILTERS.map((item) => {
            const count =
              item.id === "all"
                ? servers.length
                : servers.filter((server) => server.source === item.id).length;
            const activeFilter = filter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`rounded-full px-2.5 py-1 text-meta transition-colors ${
                  activeFilter
                    ? "bg-accent-soft font-medium text-accent"
                    : "bg-surface-2/60 text-text-secondary hover:bg-surface-hover hover:text-text"
                }`}
              >
                {item.label}
                <span className="ml-1 opacity-70">{count}</span>
              </button>
            );
          })}
          <span className="ml-auto text-caption text-text-muted">
            Nova 只渲染配置给 Agent，不改动 Claude 的原始配置
          </span>
        </div>

        {/* 列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-section">
          {loading ? (
            <div className="flex h-60 items-center justify-center gap-2 text-body text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在扫描 MCP 配置
            </div>
          ) : error ? (
            <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
              <p className="text-body text-error">{error}</p>
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  void load();
                }}
                className="ui-btn-ghost rounded-lg px-3 py-2 text-meta"
              >
                重新加载
              </button>
            </div>
          ) : servers.length === 0 ? (
            <EmptyMcp onCreate={() => setDrawer({ mode: "create" })} onImport={() => setImportOpen(true)} />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center text-text-muted">
              <Search className="h-6 w-6 opacity-50" />
              <p className="text-body">
                {query ? `没有匹配「${query}」的 MCP 服务` : "该来源下还没有 MCP 服务"}
              </p>
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="text-meta text-accent hover:underline"
                >
                  清除搜索
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((server) => (
                <McpCard
                  key={server.id}
                  server={server}
                  usage={usageCount.get(server.id) ?? 0}
                  onOpen={() => setDrawer({ mode: "view", id: server.id })}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {drawer && (drawer.mode === "create" || active) && (
        <McpDrawer
          key={drawer.mode === "view" ? drawer.id : "new"}
          server={active}
          creating={drawer.mode === "create"}
          employees={employees}
          onClose={() => setDrawer(null)}
          onSaved={async () => {
            await load();
            setDrawer(null);
          }}
        />
      )}

      <ImportMcpModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={async () => {
          await load();
          setImportOpen(false);
        }}
      />
    </main>
  );
}

// ============================================================================
// 卡片
// ============================================================================

function McpCard({
  server,
  usage,
  onOpen,
}: {
  server: McpServerAsset;
  usage: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full min-h-36 flex-col rounded-xl border border-border bg-surface-2/60 p-card text-left transition-all hover:-translate-y-0.5 hover:border-border-strong hover:bg-surface-2/85 hover:shadow-[var(--c-shadow-sm)]"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-title font-semibold text-text">{server.name}</h3>
        </div>
        <SourceTag
          label={MCP_SOURCE_LABEL[server.source]}
          className={MCP_SOURCE_CLASS[server.source]}
        />
      </div>

      <p className="mt-2.5 line-clamp-2 text-body-lg leading-relaxed text-text-secondary">
        {server.description || "暂无描述"}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
        <span className={`rounded-full px-2 py-0.5 text-meta ${MCP_TRANSPORT_CLASS[server.transport]}`}>
          {MCP_TRANSPORT_LABEL[server.transport]}
        </span>
        {server.readOnly && (
          <Tag icon={Lock} title={server.readOnlyReason ?? "只读来源"}>
            只读
          </Tag>
        )}
        {server.hasSecrets && (
          <Tag icon={KeyRound} tone="warning" title="env / headers 中存在字面量密钥">
            含密钥
          </Tag>
        )}
        {!server.valid && (
          <Tag icon={AlertTriangle} tone="error" title={server.problems.join("\n")}>
            需处理
          </Tag>
        )}
        {usage > 0 && (
          <Tag icon={Users} tone="success" title="启用该服务的数字员工数">
            {usage} 位员工
          </Tag>
        )}
        <span className="ml-auto text-meta text-text-muted">
          {formatAssetTime(server.updatedAt)}
        </span>
      </div>
    </button>
  );
}

// ============================================================================
// 详情 / 编辑抽屉
// ============================================================================

function McpDrawer({
  server,
  creating,
  employees,
  onClose,
  onSaved,
}: {
  server: McpServerAsset | null;
  creating: boolean;
  employees: DigitalEmployee[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const readOnly = !!server?.readOnly;
  const [draft, setDraft] = useState<McpServerDraft>(() =>
    server ? assetToDraft(server) : emptyDraft(),
  );
  const [saving, setSaving] = useState(false);

  const usedBy = server
    ? employees.filter((employee) =>
        employee.mcpServers.some(
          (item) => item.enabled && item.assetId === server.id,
        ),
      )
    : [];

  const update = (fields: Partial<McpServerDraft>) =>
    setDraft((current) => ({ ...current, ...fields }));

  const handleSave = async () => {
    if (saving || readOnly) return;
    setSaving(true);
    try {
      const result = server
        ? await ipc.updateMcpServer(server.id, draft)
        : await ipc.createMcpServer(draft);
      if (!result.ok) {
        toast.error(result.error, 5000);
        return;
      }
      toast.success(server ? "MCP 服务已保存" : "MCP 服务已创建");
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!server || readOnly) return;
    const suffix =
      usedBy.length > 0
        ? `\n\n有 ${usedBy.length} 位数字员工正在使用它，删除后这些员工会失去该服务。`
        : "";
    if (!window.confirm(`删除 MCP 服务「${server.name}」？${suffix}`)) return;

    try {
      const ok = await ipc.deleteMcpServer(server.id);
      if (!ok) {
        toast.error("删除失败：服务可能已不存在");
        return;
      }
      toast.success("MCP 服务已删除");
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const fileName = server ? dirName(server.path) : "新建服务";
  const title = creating ? "新建 MCP 服务" : server?.name ?? "MCP 服务";

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose} role="presentation">
      <div className="absolute inset-0 bg-bg/40 backdrop-blur-sm" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="ui-glass-strong relative flex h-full w-[720px] max-w-[94vw] flex-col border-l border-border-strong shadow-[var(--c-shadow)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex h-[var(--c-layout-header)] shrink-0 items-center gap-3 border-b border-border px-card">
          <Server className="h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-title font-semibold text-text">{title}</span>
              {server && (
                <SourceTag
                  label={MCP_SOURCE_LABEL[server.source]}
                  className={MCP_SOURCE_CLASS[server.source]}
                />
              )}
              {server && (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${MCP_TRANSPORT_CLASS[server.transport]}`}
                >
                  {MCP_TRANSPORT_LABEL[server.transport]}
                </span>
              )}
              {readOnly && <Tag icon={Lock}>只读</Tag>}
            </div>
            <div className="truncate text-meta text-text-muted">{fileName}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-section py-card">
          {readOnly && server && (
            <div className="shrink-0 rounded-lg border border-border bg-surface-2/60 p-3">
              <div className="flex items-start gap-2 text-body leading-relaxed text-text-secondary">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
                <div>
                  <p>{server.readOnlyReason}</p>
                  <p className="mt-1 text-text-muted">
                    你仍然可以在数字员工中绑定它；Nova 会在运行时把定义渲染到独立的
                    Agent 配置中，不会改动原配置。
                  </p>
                </div>
              </div>
            </div>
          )}

          {server && server.problems.length > 0 && (
            <div
              className={`shrink-0 rounded-lg border p-3 ${
                server.valid ? "border-border bg-surface-2/60" : "border-error/40 bg-error-bg"
              }`}
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${server.valid ? "text-agent-amber" : "text-error"}`} />
                <ul className="space-y-0.5 text-body leading-relaxed text-text-secondary">
                  {server.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* 元信息 */}
          {server && (
            <div className="grid shrink-0 grid-cols-2 gap-3 text-meta">
              <Meta label="配置文件" value={server.path} mono />
              <Meta label="最近更新" value={formatAssetTime(server.updatedAt)} />
              <Meta
                label="使用情况"
                value={
                  usedBy.length > 0
                    ? usedBy.map((employee) => employee.name).join("、")
                    : "尚未被数字员工绑定"
                }
              />
              <Meta label="密钥" value={server.hasSecrets ? "包含字面量，建议改用 ${VAR}" : "无 / 使用占位符"} />
            </div>
          )}

          {readOnly && server ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-1.5 flex shrink-0 items-center gap-1.5 text-meta font-medium text-text-secondary">
                <FileJson className="h-4 w-4" />
                配置内容
              </div>
              <pre className="ui-ring min-h-[240px] flex-1 overflow-auto rounded-lg border border-input-border bg-input-bg p-inset font-mono text-body leading-relaxed text-text">
                {assetToJson(server)}
              </pre>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-3 flex shrink-0 items-center justify-between gap-2">
                <span className="text-meta font-medium text-text-secondary">服务定义</span>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="ui-btn-primary flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-body font-medium disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {creating ? "创建" : "保存"}
                </button>
              </div>

              <div className="space-y-3">
                <Field label="服务名" hint="决定 Agent 侧的工具命名空间，只允许字母、数字、点、下划线和连字符">
                  <input
                    value={draft.name}
                    onChange={(event) => update({ name: event.target.value })}
                    placeholder="如 filesystem"
                    className={INPUT_CLASS}
                  />
                </Field>

                <Field label="描述">
                  <input
                    value={draft.description}
                    onChange={(event) => update({ description: event.target.value })}
                    placeholder="一句话说明这个服务提供什么能力"
                    className={INPUT_CLASS}
                  />
                </Field>

                <Field label="传输方式">
                  <Select
                    value={draft.transport}
                    onChange={(transport) =>
                      update({ transport: transport as McpTransport })
                    }
                    className={INPUT_CLASS}
                    options={[
                      { value: "stdio", label: "stdio（本地进程）" },
                      { value: "http", label: "HTTP（远程）" },
                      { value: "sse", label: "SSE（远程）" },
                    ]}
                  />
                </Field>

                {draft.transport === "stdio" ? (
                  <>
                    <Field label="启动命令">
                      <input
                        value={draft.command}
                        onChange={(event) => update({ command: event.target.value })}
                        placeholder="如 npx / uvx / node"
                        className={`${INPUT_CLASS} font-mono`}
                      />
                    </Field>
                    <Field label="参数" hint="每行一个参数；含空格的参数直接整行写，不需要额外引号">
                      <textarea
                        value={draft.args}
                        onChange={(event) => update({ args: event.target.value })}
                        rows={3}
                        placeholder={"-y\n@modelcontextprotocol/server-filesystem\nE:\\\\Project"}
                        className={`${INPUT_CLASS} resize-y font-mono`}
                      />
                    </Field>
                    <Field label="环境变量" hint="每行 KEY=VALUE；值支持 ${VAR} 占位符，例如 TOKEN=${MCP_TOKEN}">
                      <textarea
                        value={draft.env}
                        onChange={(event) => update({ env: event.target.value })}
                        rows={3}
                        placeholder={"TOKEN=${MCP_TOKEN}\nLOG_LEVEL=info"}
                        className={`${INPUT_CLASS} resize-y font-mono`}
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="服务 URL">
                      <input
                        value={draft.url}
                        onChange={(event) => update({ url: event.target.value })}
                        placeholder="https://example.com/mcp"
                        className={`${INPUT_CLASS} font-mono`}
                      />
                    </Field>
                    <Field label="请求头" hint="每行 KEY=VALUE；值支持 ${VAR} 占位符">
                      <textarea
                        value={draft.headers}
                        onChange={(event) => update({ headers: event.target.value })}
                        rows={3}
                        placeholder={"Authorization=Bearer ${MCP_TOKEN}"}
                        className={`${INPUT_CLASS} resize-y font-mono`}
                      />
                    </Field>
                  </>
                )}

                <p className="rounded-lg border border-border bg-surface-2/40 p-3 text-meta leading-relaxed text-text-muted">
                  密钥建议使用 <code className="font-mono text-text-secondary">${"{VAR}"}</code>{" "}
                  占位符，由运行环境注入；直接填写字面量会明文保存在本地 JSON 文件中，
                  Nova 只会在列表中标出「含密钥」。
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-card py-3">
          <div>
            {server && !readOnly && (
              <button
                type="button"
                onClick={handleDelete}
                className="flex items-center gap-1.5 rounded-lg border border-error/25 bg-error-bg px-3 py-2 text-body font-medium text-error transition-colors hover:bg-error/10"
              >
                <Trash2 className="h-4 w-4" />
                从 MCP 库删除
              </button>
            )}
            {readOnly && (
              <span className="text-meta text-text-muted">
                只读来源：修改请直接编辑对应配置文件
              </span>
            )}
          </div>
          {server && (
            <button
              type="button"
              onClick={async () => {
                const ok = await ipc.revealMcpServer(server.id);
                if (!ok) toast.error("无法打开配置文件");
              }}
              className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent-soft px-3.5 py-2 text-body font-medium text-accent transition-colors hover:bg-accent/15"
            >
              <FolderOpen className="h-4 w-4" />
              打开配置
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 导入
// ============================================================================

function ImportMcpModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [json, setJson] = useState("");
  const [importing, setImporting] = useState(false);

  const applyResult = async (result: Awaited<ReturnType<typeof ipc.importMcpServers>>) => {
    if (!result.ok) {
      toast.error(result.error ?? "导入失败", 5000);
      return;
    }
    if (result.imported.length === 0) return;
    toast.success(`已导入 ${result.imported.length} 个 MCP 服务`);
    if (result.error) toast.error(result.error, 5000);
    setJson("");
    await onImported();
  };

  const handlePaste = async () => {
    if (!json.trim() || importing) return;
    setImporting(true);
    try {
      await applyResult(await ipc.importMcpServers(json));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const handleFile = async () => {
    if (importing) return;
    setImporting(true);
    try {
      await applyResult(await ipc.importMcpFile());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} widthClass="w-[640px] max-w-[92vw]">
      <div className="flex max-h-[80vh] flex-col p-card">
        <ModalHeader title="导入 MCP 服务" onClose={onClose} className="mb-2" />
        <p className="mb-3 text-meta leading-relaxed text-text-muted">
          支持常见的 <code className="font-mono">{`{ "mcpServers": { ... } }`}</code>
          、单个服务对象或服务数组。导入后会写入 Claude 配置
          <code className="mx-1 font-mono">~/.claude.json</code>
          的 mcpServers，Claude 终端和 Nova 共用同一套配置。
        </p>

        <textarea
          value={json}
          onChange={(event) => setJson(event.target.value)}
          rows={10}
          placeholder={'{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "E:\\\\Project"]\n    }\n  }\n}'}
          className={`${INPUT_CLASS} resize-y font-mono text-meta`}
        />

        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
          <button
            type="button"
            onClick={handleFile}
            disabled={importing}
            className="ui-btn-ghost flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-body font-medium disabled:opacity-60"
          >
            <FolderOpen className="h-4 w-4" />
            从 JSON 文件导入
          </button>
          <button
            type="button"
            onClick={handlePaste}
            disabled={importing || !json.trim()}
            className="ui-btn-primary flex items-center gap-1.5 rounded-lg px-4 py-2 text-body font-medium disabled:opacity-50"
          >
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            导入粘贴内容
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================================
// 小件
// ============================================================================

function EmptyMcp({
  onCreate,
  onImport,
}: {
  onCreate: () => void;
  onImport: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-3 py-20 text-center text-text-muted">
      <div className="ui-btn-round flex h-16 w-16 items-center justify-center rounded-2xl">
        <Server className="h-6 w-6" />
      </div>
      <h2 className="ui-serif text-heading font-semibold text-text-secondary">
        管理 MCP 服务
      </h2>
      <p className="text-body-lg leading-relaxed">
        从 Claude 配置导入，或新建一个 stdio / HTTP 服务，然后在数字员工中勾选绑定。
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onImport}
          className="ui-btn-primary flex h-8 items-center gap-1.5 rounded-full px-4 text-body font-medium"
        >
          <Upload className="h-4 w-4" />
          导入 MCP
        </button>
        <button
          type="button"
          onClick={onCreate}
          className="ui-btn-ghost flex h-8 items-center gap-1.5 rounded-full px-4 text-body font-medium"
        >
          <Plus className="h-4 w-4" />
          新建 MCP
        </button>
      </div>
    </div>
  );
}
