/**
 * 运行环境 · Agent 配置 — Nova 自管的 Agent 连接配置
 *
 * 布局：
 * - 左侧：Agent 列表（当前只有 Claude Code 可配置，其余显示为即将支持）
 * - 右侧：分步引导（安装 → 连接 → 模型）+ 配置卡片 + 固定操作栏
 *
 * 这里的配置与「数字员工」「工作流运行时」共用：
 * 页面负责“能连上哪个端点、有哪些模型”，员工负责“这个节点用哪个模型”。
 * 运行期不会读取本机 Claude 配置；本机配置只能通过「从本机导入」一次性带过来。
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Loader2,
  PlugZap,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
  XCircle,
} from "lucide-react";
import type {
  AgentConnection,
  AgentConnectionProbeResult,
  AgentModelOption,
} from "@shared/contracts/agent";
import { ipc } from "../../lib/ipc";
import { useChatStore } from "../../stores/chat";
import { toast } from "../../stores/toast";
import { clearAgentModelsCache } from "../../hooks/useAgentModels";
import { Field, FORM_INPUT_CLASS } from "../ui/Field";
import { Modal, ModalHeader } from "../ui/Modal";
import { Select } from "../ui/Select";

const CLAUDE_ID = "claude";
const INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

interface FormState {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

export function AgentsView() {
  const agents = useChatStore((state) => state.agents);
  const detectAgents = useChatStore((state) => state.detectAgents);

  const claude = agents.find((agent) => agent.id === CLAUDE_ID);
  const installed = claude?.status.installed ?? false;

  const [connection, setConnection] = useState<AgentConnection | null>(null);
  const [form, setForm] = useState<FormState>({
    baseUrl: "",
    apiKey: "",
    defaultModel: "",
  });
  const [models, setModels] = useState<AgentModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [reDetecting, setReDetecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [probe, setProbe] = useState<AgentConnectionProbeResult | null>(null);
  const [probeMode, setProbeMode] = useState<"test" | "models">("test");
  const probeRef = useRef<HTMLDivElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [clearKeyArmed, setClearKeyArmed] = useState(false);
  const [lastImport, setLastImport] = useState<{
    source: string;
    warnings: string[];
  } | null>(null);

  const applyConnection = (next: AgentConnection) => {
    // 已保存的默认模型如果不在模型列表里，说明配置已经不一致：
    // 自动切到列表第一个，避免下拉里出现一个列表之外的「幽灵模型」。
    let defaultModel = next.defaultModel;
    const hasList = next.models.length > 0;
    if (
      hasList &&
      (!defaultModel || !next.models.some((model) => model.value === defaultModel))
    ) {
      defaultModel = next.models[0].value;
      toast.info(
        `已保存的默认模型不在模型列表中，已切换为「${next.models[0].label}」`,
      );
    }

    setConnection(next);
    setModels(next.models);
    setForm({
      baseUrl: next.baseUrl,
      apiKey: "",
      defaultModel,
    });
    setProbe(null);
    setClearKeyArmed(false);
  };

  /**
   * 查询 / 测试拿到新模型列表后应用。
   * 旧默认模型不在新列表里时自动切到第一个，保证下拉选项与接口返回完全一致。
   */
  const applyFreshModels = (next: AgentModelOption[]) => {
    setModels(next);
    if (next.length === 0) return;

    const current = form.defaultModel;
    if (current && next.some((model) => model.value === current)) return;

    const first = next[0];
    setForm((state) => ({ ...state, defaultModel: first.value }));
    toast.info(`已自动选择默认模型「${first.label}」`);
  };

  const loadConnection = async () => {
    const next = await ipc.getAgentConnection(CLAUDE_ID);
    applyConnection(next);
    setLoadError(null);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await ipc.getAgentConnection(CLAUDE_ID);
        if (!cancelled) applyConnection(next);
      } catch (err) {
        if (!cancelled) setLoadError(messageOf(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    // 安装状态复用全局检测，不额外起一套
    void detectAgents().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [detectAgents]);

  // 「清除密钥」二次确认 3 秒后自动复位
  useEffect(() => {
    if (!clearKeyArmed) return;
    const timer = setTimeout(() => setClearKeyArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [clearKeyArmed]);

  // 测试 / 查询模型的结果可能出现在首屏下方，自动滚到可见位置
  useEffect(() => {
    if (!probe) return;
    probeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [probe]);

  const dirty = useMemo(() => {
    if (!connection) return false;
    return (
      form.baseUrl !== connection.baseUrl ||
      form.defaultModel !== connection.defaultModel ||
      form.apiKey.trim() !== "" ||
      !sameModels(models, connection.models)
    );
  }, [connection, form, models]);

  const steps = [
    { key: "install", label: "安装", done: installed },
    {
      key: "connection",
      label: "连接",
      done: Boolean(connection?.hasApiKey || connection?.oauthAvailable),
    },
    {
      key: "model",
      label: "模型",
      done: Boolean(form.defaultModel),
    },
  ];

  const patchForm = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setProbe(null);
    setClearKeyArmed(false);
  };

  const handleReDetect = async () => {
    setReDetecting(true);
    try {
      await detectAgents();
      const latest = useChatStore
        .getState()
        .agents.find((agent) => agent.id === CLAUDE_ID);
      if (latest?.status.installed) {
        toast.success(
          latest.status.version
            ? `已检测到 Claude Code ${latest.status.version}`
            : "已检测到 Claude Code",
        );
      } else {
        toast.error("仍未检测到 Claude Code，请确认安装完成并重启 Nova");
      }
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setReDetecting(false);
    }
  };

  const handleCopyInstall = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      toast.success("安装命令已复制");
    } catch {
      toast.error("复制失败，请手动选择命令");
    }
  };

  const handleFetchModels = async () => {
    setFetchingModels(true);
    setProbe(null);
    setProbeMode("models");
    try {
      const result = await ipc.probeAgentModels({
        agentId: CLAUDE_ID,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey.trim() || undefined,
        model: "",
      });
      setProbe(result);
      if (result.models && result.models.length > 0) {
        applyFreshModels(result.models);
      }
      if (result.ok) {
        toast.success(
          result.models?.length
            ? `已获取 ${result.models.length} 个模型`
            : "接口可访问，但没有返回模型",
        );
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setFetchingModels(false);
    }
  };

  const handleTest = async () => {
    setProbing(true);
    setProbe(null);
    setProbeMode("test");
    try {
      const result = await ipc.testAgentConnection({
        agentId: CLAUDE_ID,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey.trim() || undefined,
        model: form.defaultModel,
      });
      setProbe(result);
      if (result.models && result.models.length > 0) {
        applyFreshModels(result.models);
      }
      toast[result.ok ? "success" : "error"](
        result.ok ? "连接测试通过" : "连接测试未通过",
      );
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setProbing(false);
    }
  };

  const handleSave = async () => {
    if (!form.defaultModel.trim()) {
      toast.error("请先选择或填写默认模型");
      return;
    }
    setSaving(true);
    try {
      const updated = await ipc.saveAgentConnection({
        agentId: CLAUDE_ID,
        baseUrl: form.baseUrl,
        defaultModel: form.defaultModel,
        apiKey: form.apiKey.trim() === "" ? undefined : form.apiKey.trim(),
        models,
      });
      applyConnection(updated);
      clearAgentModelsCache(CLAUDE_ID);
      toast.success("连接配置已保存");
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const handleOpenConfigFile = async () => {
    try {
      const opened = await ipc.openAgentConfigFile(CLAUDE_ID);
      if (!opened) {
        toast.error("配置文件尚未生成，请先保存连接配置");
      }
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  const handleClearKey = async () => {
    if (!clearKeyArmed) {
      setClearKeyArmed(true);
      return;
    }
    setClearKeyArmed(false);
    setSaving(true);
    try {
      const updated = await ipc.saveAgentConnection({
        agentId: CLAUDE_ID,
        baseUrl: form.baseUrl,
        defaultModel: form.defaultModel,
        apiKey: "",
        models,
      });
      applyConnection(updated);
      clearAgentModelsCache(CLAUDE_ID);
      toast.success("已清除保存的 API Key");
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const result = await ipc.importLocalAgentConnection(CLAUDE_ID);
      applyConnection(result.connection);
      clearAgentModelsCache(CLAUDE_ID);
      setLastImport({ source: result.source, warnings: result.warnings });
      setImportOpen(false);

      const parts: string[] = [];
      if (result.imported.baseUrl) parts.push("Base URL");
      if (result.imported.apiKey) parts.push("API Key");
      if (result.imported.models > 0) {
        parts.push(`${result.imported.models} 个模型`);
      }
      toast.success(
        parts.length > 0
          ? `已导入：${parts.join(" / ")}`
          : "已读取本机配置，但没有可导入的字段",
      );
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setImporting(false);
    }
  };

  // 下拉只展示查询到的模型，不再补一个「当前（不在列表中）」的幽灵选项
  const modelOptions = useMemo(
    () =>
      models.map((model) => ({
        value: model.value,
        label: model.label,
      })),
    [models],
  );

  const otherAgents = agents.filter((agent) => agent.id !== CLAUDE_ID);

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden rounded-xl">
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-3 border-b border-border px-card">
          <div className="flex min-w-0 items-center gap-2">
            <span className="ui-serif text-title font-semibold tracking-wide text-text-secondary">
              Agent 配置
            </span>
            <span className="rounded-full bg-surface-hover px-2 py-0.5 text-caption font-mono text-text-muted">
              连接配置
            </span>
          </div>

          <button
            type="button"
            onClick={handleReDetect}
            disabled={reDetecting}
            className="ui-btn-ghost flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-meta font-medium disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${reDetecting ? "animate-spin" : ""}`}
            />
            重新检测
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* 左侧 Agent 列表 */}
          <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface-2/30 p-3">
            <div className="px-1 pb-2 text-meta font-medium tracking-wide text-text-muted">
              Agent
            </div>

            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-2.5 py-2.5 text-left"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Bot className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-body font-medium text-text">
                    Claude Code
                  </span>
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      installed ? "bg-success" : "bg-error"
                    }`}
                  />
                </span>
                <span className="mt-0.5 block truncate text-caption text-text-muted">
                  {installed
                    ? claude?.status.version
                      ? `已安装 · ${claude.status.version}`
                      : "已安装"
                    : "未安装"}
                </span>
              </span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-accent" />
            </button>

            {otherAgents.map((agent) => (
              <div
                key={agent.id}
                className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2.5 opacity-60"
                title="该 Agent 的连接配置将在后续版本支持"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-text-muted">
                  <Bot className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-body font-medium text-text-secondary">
                      {agent.displayName}
                    </span>
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        agent.status.installed ? "bg-success" : "bg-error"
                      }`}
                    />
                  </span>
                  <span className="mt-0.5 block truncate text-caption text-text-muted">
                    即将支持
                  </span>
                </span>
              </div>
            ))}

            <div className="mt-4 rounded-lg border border-border bg-surface-2/50 p-3 text-caption leading-relaxed text-text-muted">
              <p className="mb-1 font-medium text-text-secondary">
                为什么单独配置？
              </p>
              工作流节点使用 Nova 自管的连接配置。每个节点执行时都会创建全新的隔离环境，不读取也不会改动本机
              Claude 配置。
            </div>
          </aside>

          {/* 右侧配置区 */}
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto p-section">
              <div className="mx-auto max-w-3xl space-y-4 pb-6">
                {loading ? (
                  <div className="flex h-60 items-center justify-center gap-2 text-body text-text-muted">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在加载连接配置
                  </div>
                ) : loadError ? (
                  <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
                    <p className="text-body text-error">{loadError}</p>
                    <button
                      type="button"
                      onClick={() => {
                        setLoading(true);
                        void loadConnection()
                          .catch((err) => setLoadError(messageOf(err)))
                          .finally(() => setLoading(false));
                      }}
                      className="ui-btn-ghost rounded-lg px-3 py-2 text-meta"
                    >
                      重新加载
                    </button>
                  </div>
                ) : (
                  <>
                    {/* 步骤条 */}
                    <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2/50 px-4 py-3">
                      {steps.map((step, index) => (
                        <Fragment key={step.key}>
                          <div className="flex shrink-0 items-center gap-2">
                            <span
                              className={`flex h-6 w-6 items-center justify-center rounded-full text-caption font-medium ${
                                step.done
                                  ? "bg-success/15 text-success"
                                  : "bg-surface-hover text-text-muted"
                              }`}
                            >
                              {step.done ? (
                                <Check className="h-3.5 w-3.5" />
                              ) : (
                                index + 1
                              )}
                            </span>
                            <span
                              className={`text-meta ${
                                step.done ? "text-text" : "text-text-muted"
                              }`}
                            >
                              {step.label}
                            </span>
                          </div>
                          {index < steps.length - 1 && (
                            <div className="h-px min-w-4 flex-1 bg-border" />
                          )}
                        </Fragment>
                      ))}
                    </div>

                    {/* 1. 运行环境 */}
                    <SectionCard
                      title="运行环境"
                      description="Nova 通过本机安装的 Claude Code CLI 执行节点与对话。"
                      icon={Terminal}
                      action={
                        <StatusBadge
                          ok={installed}
                          okText="已安装"
                          failText="未安装"
                        />
                      }
                    >
                      {installed ? (
                        <div className="flex items-center justify-between gap-3 rounded-lg bg-input-bg px-inset py-2.5">
                          <div className="flex min-w-0 items-center gap-2 text-body text-text">
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                            <span className="truncate">Claude Code</span>
                            <span className="shrink-0 font-mono text-meta text-text-muted">
                              {claude?.status.version
                                ? `v${claude.status.version.replace(/^v/, "")}`
                                : "版本未知"}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={handleReDetect}
                            disabled={reDetecting}
                            className="shrink-0 rounded-md px-2 py-1 text-meta text-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
                          >
                            {reDetecting ? "检测中…" : "重新检测"}
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="flex items-start gap-2 rounded-lg bg-error-bg/40 px-inset py-2.5 text-meta leading-relaxed text-text-secondary">
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-error" />
                            未检测到 Claude Code。请先在终端执行下面的命令安装，完成后回到这里点击「重新检测」。
                          </div>
                          <div className="flex items-center gap-2 rounded-lg border border-border bg-input-bg px-inset py-2">
                            <code className="min-w-0 flex-1 truncate font-mono text-meta text-text">
                              {INSTALL_COMMAND}
                            </code>
                            <button
                              type="button"
                              onClick={handleCopyInstall}
                              className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-meta text-accent transition-colors hover:bg-accent-soft"
                            >
                              <Copy className="h-3.5 w-3.5" />
                              复制
                            </button>
                          </div>
                          <p className="text-caption leading-relaxed text-text-muted">
                            安装后若仍检测不到，请重启 Nova 以刷新 PATH。
                          </p>
                        </div>
                      )}
                    </SectionCard>

                    {/* 2. 连接配置 */}
                    <SectionCard
                      title="连接配置"
                      description="由 Nova 独立保存；保存时生成 settings.json（接入配置）与 models.json（模型清单），节点执行时直接复制。"
                      icon={ShieldCheck}
                      action={
                        <button
                          type="button"
                          onClick={() => setImportOpen(true)}
                          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-meta text-accent transition-colors hover:bg-accent-soft"
                        >
                          <Download className="h-3.5 w-3.5" />
                          从本机导入
                        </button>
                      }
                    >
                      <div className="space-y-4">
                        <div>
                          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-input-bg px-inset py-2 text-caption text-text-muted">
                            <FileText className="h-3.5 w-3.5 shrink-0" />
                            <span
                              title={connection?.settingsPath}
                              className="min-w-0 flex-1 truncate font-mono text-[11px] leading-relaxed"
                            >
                              {connection?.settingsPath || "保存后生成"}
                            </span>
                            <button
                              type="button"
                              onClick={handleOpenConfigFile}
                              className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-meta text-accent transition-colors hover:bg-accent-soft"
                            >
                              <FolderOpen className="h-3.5 w-3.5" />
                              打开所在目录
                            </button>
                          </div>
                          <p className="mt-1 text-caption leading-relaxed text-text-muted">
                            该目录由 Nova 生成：settings.json 含明文 API Key，models.json
                            缓存模型清单。手动修改会在下次保存时被覆盖。
                          </p>
                        </div>

                        <Field
                          label="Base URL"
                          hint="留空使用官方端点 https://api.anthropic.com；第三方 Anthropic 兼容服务填写其根地址。"
                        >
                          <input
                            value={form.baseUrl}
                            onChange={(event) =>
                              patchForm({ baseUrl: event.target.value })
                            }
                            placeholder="https://api.anthropic.com"
                            spellCheck={false}
                            className={FORM_INPUT_CLASS}
                          />
                        </Field>

                        <Field
                          label="API Key"
                          required={!connection?.oauthAvailable}
                          hint={
                            connection?.oauthAvailable && !connection.hasApiKey
                              ? "检测到本机 OAuth 登录凭证，可以留空；运行时会复制一份凭证到隔离目录。"
                              : "官方端点使用 x-api-key，自定义端点使用 Bearer；保存后会写入标准配置文件（明文 Key），节点执行时直接复制该文件。"
                          }
                        >
                          <div className="relative">
                            <input
                              type={showKey ? "text" : "password"}
                              value={form.apiKey}
                              onChange={(event) =>
                                patchForm({ apiKey: event.target.value })
                              }
                              placeholder={
                                connection?.keyUnreadable
                                  ? "已保存的密钥无法在当前设备解密，请重新输入"
                                  : connection?.hasApiKey
                                    ? `已保存 ${connection.apiKeyHint}，留空保持不变`
                                    : "输入 API Key"
                              }
                              spellCheck={false}
                              autoComplete="off"
                              className={`${FORM_INPUT_CLASS} pr-24`}
                            />
                            <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => setShowKey((value) => !value)}
                                title={showKey ? "隐藏密钥" : "显示密钥"}
                                className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
                              >
                                {showKey ? (
                                  <EyeOff className="h-4 w-4" />
                                ) : (
                                  <Eye className="h-4 w-4" />
                                )}
                              </button>
                              {(connection?.hasApiKey ||
                                connection?.keyUnreadable) && (
                                <button
                                  type="button"
                                  onClick={handleClearKey}
                                  className={`rounded-md px-1.5 py-1 text-caption transition-colors ${
                                    clearKeyArmed
                                      ? "bg-error-bg text-error"
                                      : "text-text-muted hover:bg-surface-hover hover:text-error"
                                  }`}
                                >
                                  {clearKeyArmed ? "确认清除" : "清除"}
                                </button>
                              )}
                            </div>
                          </div>
                        </Field>

                        {connection?.keyUnreadable && (
                          <div className="flex items-start gap-2 rounded-lg bg-error-bg/30 px-inset py-2 text-caption leading-relaxed text-text-secondary">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" />
                            已保存的密钥无法在当前设备解密（常见于复制数据库或还原备份），请重新填写
                            API Key。
                          </div>
                        )}

                        <Field
                          label="默认模型"
                          required
                          hint="必填：数字员工未指定模型时使用；工作流里每个节点仍可绑定不同模型。"
                        >
                          <div className="flex items-center gap-2">
                            {models.length > 0 ? (
                              <Select
                                value={form.defaultModel}
                                onChange={(value) =>
                                  patchForm({ defaultModel: value })
                                }
                                className={`${FORM_INPUT_CLASS} min-w-0 flex-1`}
                                minMenuWidth={320}
                                placeholder="请选择模型"
                                options={modelOptions}
                              />
                            ) : (
                              <input
                                value={form.defaultModel}
                                onChange={(event) =>
                                  patchForm({
                                    defaultModel: event.target.value,
                                  })
                                }
                                placeholder="点击「查询模型」，或手动填写模型名"
                                spellCheck={false}
                                className={`${FORM_INPUT_CLASS} min-w-0 flex-1`}
                              />
                            )}
                            <button
                              type="button"
                              onClick={handleFetchModels}
                              disabled={fetchingModels}
                              className="ui-btn-ghost flex h-[38px] shrink-0 items-center gap-1.5 rounded-lg px-3 text-meta font-medium disabled:opacity-50"
                            >
                              {fetchingModels ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3.5 w-3.5" />
                              )}
                              查询模型
                            </button>
                          </div>
                        </Field>
                      </div>
                    </SectionCard>

                    {/* 测试 / 查询结果：紧跟在连接配置下方，避免落在首屏之外 */}
                    <div ref={probeRef}>
                      {probe && (
                        <ProbeResultCard result={probe} mode={probeMode} />
                      )}
                    </div>

                    {/* 3. 模型列表 */}
                    <SectionCard
                      title="可用模型"
                      description={
                        models.length > 0
                          ? `共 ${models.length} 个模型，仅供查看；默认模型请在上方选择。`
                          : "尚未获取模型列表。"
                      }
                      icon={Sparkles}
                      action={
                        connection?.modelsUpdatedAt ? (
                          <span className="shrink-0 text-caption text-text-muted">
                            上次获取：
                            {formatTime(connection.modelsUpdatedAt)}
                          </span>
                        ) : null
                      }
                    >
                      {models.length === 0 ? (
                        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-8 text-center text-text-muted">
                          <Sparkles className="h-5 w-5 opacity-50" />
                          <p className="text-meta">
                            点击「查询模型」从接口拉取全部可用模型
                          </p>
                          <p className="text-caption">
                            若服务不提供 /v1/models，可直接在「默认模型」里填写
                          </p>
                        </div>
                      ) : (
                        <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
                          {models.map((model) => {
                            const active =
                              form.defaultModel === model.value;
                            return (
                              <span
                                key={model.value}
                                title={model.hint || model.value}
                                className={`flex cursor-default items-center gap-1 rounded-full border px-2.5 py-1 text-meta ${
                                  active
                                    ? "border-accent bg-accent-soft font-medium text-accent"
                                    : "border-border bg-input-bg text-text-secondary"
                                }`}
                              >
                                {active && <Check className="h-3 w-3" />}
                                {model.label}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </SectionCard>

                    {/* 本机导入提示 */}
                    {lastImport && lastImport.warnings.length > 0 && (
                      <div className="rounded-xl border border-border bg-surface-2/60 px-4 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-meta font-medium text-text-secondary">
                            导入提示
                          </p>
                          <button
                            type="button"
                            onClick={() => setLastImport(null)}
                            title="关闭"
                            className="rounded p-0.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <ul className="mt-1.5 space-y-1 text-caption leading-relaxed text-text-muted">
                          {lastImport.warnings.map((warning) => (
                            <li key={warning}>• {warning}</li>
                          ))}
                        </ul>
                        <p className="mt-1.5 truncate text-caption text-text-muted">
                          来源：{lastImport.source}
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* 固定操作栏 */}
            <footer className="ui-glass shrink-0 border-t border-border px-section py-3">
              <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 text-caption text-text-muted">
                  {connection?.updatedAt
                    ? `上次保存：${formatTime(connection.updatedAt)}`
                    : "尚未保存"}
                  {dirty && (
                    <span className="ml-2 text-accent">有未保存的修改</span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={handleTest}
                    disabled={probing || loading}
                    className="ui-btn-ghost flex h-8 items-center gap-1.5 rounded-full px-3.5 text-meta font-medium disabled:opacity-50"
                  >
                    {probing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <PlugZap className="h-3.5 w-3.5" />
                    )}
                    测试连接
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !dirty}
                    className="ui-btn-primary flex h-8 items-center gap-1.5 rounded-full px-4 text-meta font-medium disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    保存
                  </button>
                </div>
              </div>
            </footer>
          </section>
        </div>
      </div>

      <ImportDialog
        open={importOpen}
        importing={importing}
        onClose={() => setImportOpen(false)}
        onConfirm={handleImport}
      />
    </main>
  );
}

// ============================================================================
// 子组件
// ============================================================================

function SectionCard({
  title,
  description,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  description?: string;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface-2/60 p-card">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-body font-semibold text-text">
            <Icon className="h-4 w-4 shrink-0 text-accent" />
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-meta leading-relaxed text-text-muted">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function StatusBadge({
  ok,
  okText,
  failText,
}: {
  ok: boolean;
  okText: string;
  failText: string;
}) {
  return (
    <span
      className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium ${
        ok ? "bg-success/15 text-success" : "bg-error-bg text-error"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-success" : "bg-error"}`}
      />
      {ok ? okText : failText}
    </span>
  );
}

function ProbeResultCard({
  result,
  mode,
}: {
  result: AgentConnectionProbeResult;
  mode: "test" | "models";
}) {
  const title =
    mode === "models"
      ? result.ok
        ? "模型查询成功"
        : "模型查询失败"
      : result.ok
        ? "连接测试通过"
        : "连接测试未通过";

  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        result.ok
          ? "border-success/40 bg-success/5"
          : "border-error/40 bg-error-bg/30"
      }`}
    >
      <div className="flex items-start gap-2">
        {result.ok ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        ) : (
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-error" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-text">{title}</p>
          <p className="mt-0.5 break-words text-meta leading-relaxed text-text-secondary">
            {result.message}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-muted">
            <span>耗时 {result.latencyMs} ms</span>
            {result.httpStatus !== undefined && (
              <span>HTTP {result.httpStatus}</span>
            )}
            {result.modelVerified === true && (
              <span className="text-success">模型已确认</span>
            )}
            {result.modelVerified === false && (
              <span className="text-error">模型未确认</span>
            )}
            {typeof result.models?.length === "number" &&
              result.models.length > 0 && (
                <span>{result.models.length} 个模型</span>
              )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ImportDialog({
  open,
  importing,
  onClose,
  onConfirm,
}: {
  open: boolean;
  importing: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      widthClass="w-[520px] max-w-[90vw]"
    >
      <div className="p-5">
        <ModalHeader title="从本机 Claude 导入" onClose={onClose} />
        <div className="space-y-3 text-body leading-relaxed text-text-secondary">
          <p>
            将读取本机{" "}
            <code className="rounded bg-surface-hover px-1 py-0.5 font-mono text-meta text-text">
              ~/.claude/settings.json
            </code>{" "}
            中的 Base URL、API Key 与模型映射，一次性写入 Nova。
          </p>
          <p>
            导入后运行期与本机配置彻底解耦：之后修改本机 Claude
            配置不会影响工作流节点。
          </p>
          <div className="rounded-lg bg-surface-hover/60 px-3 py-2 text-meta leading-relaxed text-text-muted">
            不会导入 hooks、plugins、全局 skills、历史会话等运行资产；这些内容也不会在节点运行时被继承。
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={importing}
            className="ui-btn-ghost rounded-lg px-3 py-2 text-meta disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={importing}
            className="ui-btn-primary flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-meta font-medium disabled:opacity-50"
          >
            {importing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            开始导入
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================================
// 工具函数
// ============================================================================

function sameModels(a: AgentModelOption[], b: AgentModelOption[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((model, index) => model.value === b[index]?.value);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
