/**
 * Agent 平台 — Agent 本机配置的统一入口
 *
 * 当前只支持 Claude Code：
 * - 显示 Base URL / API Key / 默认模型 / 模型别名 / 默认权限
 * - 修改直接写回 ~/.claude/settings.json，Claude CLI 与 Nova 共用同一份配置
 * - 未安装时展示安装命令与检测入口
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  Bot,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCw,
  Save,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import {
  AGENT_MODEL_ALIASES,
  type AgentInfo,
  type AgentModelAlias,
  type AgentModelEntry,
  type AgentModelOption,
  type AgentSettingsDraft,
  type AgentSettingsView,
} from "@shared/contracts/agent";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { useChatStore } from "../../stores/chat";
import { toast } from "../../stores/toast";
import { Button } from "../ui/Button";
import { Combobox } from "../ui/Combobox";
import { Field, FORM_INPUT_CLASS } from "../ui/Field";
import { Select } from "../ui/Select";
import { Page, PageHeader } from "../ui/Page";
import { EmptyState } from "../ui/EmptyState";

const CLAUDE_ID = "claude";

/** 模型名 / 上下文并排输入：去掉表单默认的 w-full，避免上下文框把模型名挤没 */
const SPLIT_INPUT_CLASS = FORM_INPUT_CLASS.replace(/\bw-full\b/, "").trim();

/** 别名来自共享契约：设置读写与 UI 共用同一份槽位列表 */
const MODEL_ALIASES: ReadonlyArray<{
  key: AgentModelAlias;
  label: string;
  hint: string;
}> = AGENT_MODEL_ALIASES.map((key) => ({
  key,
  label: key.charAt(0).toUpperCase() + key.slice(1),
  hint: `ANTHROPIC_DEFAULT_${key.toUpperCase()}_MODEL`,
}));

/** 上下文后缀候选；当前配置中的特殊值会自动追加 */
const CONTEXT_OPTIONS = [
  { value: "", label: "默认" },
  { value: "200K", label: "200K" },
  { value: "1M", label: "1M" },
];

/** 当前值不在预设内时补进候选项，避免打开下拉时显示为空 */
function contextOptions(current: string) {
  const value = current.trim();
  if (!value || CONTEXT_OPTIONS.some((option) => option.value === value)) {
    return CONTEXT_OPTIONS;
  }
  return [...CONTEXT_OPTIONS, { value, label: value }];
}

/** Claude Code 标准权限模式；label 直接使用官方模式名，避免意译造成的歧义 */
const PERMISSION_OPTIONS = [
  { value: "default", label: "default" },
  { value: "auto", label: "auto" },
  { value: "acceptEdits", label: "acceptEdits" },
  { value: "plan", label: "plan" },
  { value: "dontAsk", label: "dontAsk" },
  { value: "bypassPermissions", label: "bypassPermissions" },
];

/** 右侧配置区的分区锚点 */
const SECTION_NAV = [
  { id: "connection", label: "连接配置" },
  { id: "models", label: "模型配置" },
  { id: "permission", label: "默认权限" },
  { id: "file", label: "配置文件" },
] as const;
type SectionId = (typeof SECTION_NAV)[number]["id"];

interface FormState {
  baseUrl: string;
  apiKey: string;
  defaultModel: AgentModelEntry;
  modelAliases: Record<AgentModelAlias, AgentModelEntry>;
  permissionMode: string;
}

function toForm(view: AgentSettingsView): FormState {
  return {
    baseUrl: view.baseUrl,
    apiKey: view.apiKey,
    defaultModel: { ...view.defaultModel },
    modelAliases: Object.fromEntries(
      MODEL_ALIASES.map(({ key }) => [key, { ...view.modelAliases[key] }]),
    ) as Record<AgentModelAlias, AgentModelEntry>,
    permissionMode: view.permissionMode,
  };
}

function sameModelEntry(a: AgentModelEntry, b: AgentModelEntry): boolean {
  return a.name === b.name && a.context === b.context;
}

export function AgentsView() {
  const agents = useChatStore((state) => state.agents);
  const detectAgents = useChatStore((state) => state.detectAgents);

  const [selectedId, setSelectedId] = useState<string>("");
  const [settings, setSettings] = useState<AgentSettingsView | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [remoteModels, setRemoteModels] = useState<AgentModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  /** 只接受最后一次请求的结果，避免旧响应覆盖新列表 */
  const modelRequestRef = useRef(0);
  /** 右侧配置区：滚动容器 + 当前分区 */
  const contentRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<SectionId>("connection");

  const scrollToSection = (id: SectionId) => {
    document
      .getElementById(`agent-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(id);
  };

  /** 滚动时高亮离顶部最近的分区 */
  const handleContentScroll = () => {
    const container = contentRef.current;
    if (!container) return;
    // 以容器顶部往下约 280px 作为「正在阅读」的分界，避免要等分区顶到
    // 吸顶导航下面才切换高亮
    const threshold =
      container.getBoundingClientRect().top +
      Math.min(280, container.clientHeight * 0.35);
    let current: SectionId = "connection";
    for (const item of SECTION_NAV) {
      const element = document.getElementById(`agent-${item.id}`);
      if (element && element.getBoundingClientRect().top <= threshold) {
        current = item.id;
      }
    }
    setActiveSection(current);
  };

  /** 按当前 Base URL / API Key 重新拉取模型列表 */
  const refreshModelList = useCallback(async () => {
    if (!form) return;
    const requestId = ++modelRequestRef.current;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const models = await ipc.listAgentModels({
        agentId: CLAUDE_ID,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
      });
      if (requestId !== modelRequestRef.current) return;
      setRemoteModels(models);
    } catch (err) {
      if (requestId !== modelRequestRef.current) return;
      setRemoteModels([]);
      setModelsError(toMessage(err));
    } finally {
      if (requestId === modelRequestRef.current) setModelsLoading(false);
    }
  }, [form?.baseUrl, form?.apiKey]);

  useEffect(() => {
    if (selectedId || agents.length === 0) return;
    const preferred =
      agents.find((agent) => agent.id === CLAUDE_ID) ?? agents[0];
    setSelectedId(preferred.id);
  }, [agents, selectedId]);

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? agents[0],
    [agents, selectedId],
  );

  // 加载 Claude 本机配置
  useEffect(() => {
    if (selected?.id !== CLAUDE_ID) {
      setSettings(null);
      setForm(null);
      setLoadError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    ipc
      .getAgentSettings(CLAUDE_ID)
      .then((view) => {
        if (cancelled) return;
        setSettings(view);
        setForm(toForm(view));
      })
      .catch((err) => {
        if (cancelled) return;
        setSettings(null);
        setForm(null);
        setLoadError(toMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  // 配置加载 / 保存完成后自动拉取一次；之后每次展开下拉时按最新输入刷新
  useEffect(() => {
    if (!settings || !form) return;
    void refreshModelList();
    // refreshModelList 依赖实时表单值，这里只在配置整体变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const dirty = useMemo(() => {
    if (!settings || !form) return false;
    return (
      form.baseUrl !== settings.baseUrl ||
      form.apiKey !== settings.apiKey ||
      !sameModelEntry(form.defaultModel, settings.defaultModel) ||
      form.permissionMode !== settings.permissionMode ||
      MODEL_ALIASES.some(
        ({ key }) =>
          !sameModelEntry(form.modelAliases[key], settings.modelAliases[key]),
      )
    );
  }, [settings, form]);

  const liveModelCount = useMemo(() => {
    if (!form) return 0;
    return new Set(
      [
        form.defaultModel.name,
        ...Object.values(form.modelAliases).map((entry) => entry.name),
      ]
        .map((name) => name.trim())
        .filter(Boolean),
    ).size;
  }, [form]);

  const modelNameOptions = useMemo(() => {
    // 远端列表优先；当前配置里已有但远端未返回的模型名也要保留，
    // 否则打开下拉时看不到当前值。
    const options = new Map<string, string>();
    for (const model of remoteModels) {
      options.set(
        model.id,
        model.displayName && model.displayName !== model.id
          ? `${model.displayName} (${model.id})`
          : model.id,
      );
    }
    if (settings) {
      for (const entry of [
        settings.defaultModel,
        ...MODEL_ALIASES.map(({ key }) => settings.modelAliases[key]),
      ]) {
        const name = entry.name.trim();
        if (name && !options.has(name)) options.set(name, name);
      }
    }
    return Array.from(options, ([value, label]) => ({ value, label }));
  }, [remoteModels, settings]);

  const modelListHint = modelsLoading
    ? "正在按当前 Base URL 与 API Key 获取模型列表…"
    : modelsError
      ? `模型列表获取失败：${modelsError}`
      : "模型列表按当前 Base URL 与 API Key 动态获取；也可直接输入自定义模型名。";

  const permissionOptions = useMemo(() => {
    if (!form) return PERMISSION_OPTIONS;
    return PERMISSION_OPTIONS.some((option) => option.value === form.permissionMode)
      ? PERMISSION_OPTIONS
      : [
          {
            value: form.permissionMode,
            label: `${form.permissionMode} (current)`,
          },
          ...PERMISSION_OPTIONS,
        ];
  }, [form]);

  const refreshAgents = async () => {
    setDetecting(true);
    try {
      await detectAgents();
      toast.success("已重新检测本机 Agent");
    } catch (err) {
      toast.error(toMessage(err));
    } finally {
      setDetecting(false);
    }
  };

  const handleCopyInstall = async () => {
    if (!selected?.installCommand) return;
    try {
      await navigator.clipboard.writeText(selected.installCommand);
      toast.success("安装命令已复制");
    } catch {
      toast.error("复制失败，请手动选择命令");
    }
  };

  const handleOpenConfig = async () => {
    if (!selected) return;
    if (!selected.configPath && !settings?.settingsPath) {
      toast.error("该 Agent 没有可打开的本机配置目录");
      return;
    }
    setOpening(true);
    try {
      const opened = await ipc.openAgentConfigDir(selected.id);
      if (!opened) toast.error("配置目录不存在或无法打开");
    } catch (err) {
      toast.error(toMessage(err));
    } finally {
      setOpening(false);
    }
  };

  const handleReload = async () => {
    if (selected?.id !== CLAUDE_ID) return;
    setLoading(true);
    setLoadError(null);
    try {
      const view = await ipc.getAgentSettings(CLAUDE_ID);
      setSettings(view);
      setForm(toForm(view));
      toast.success("已重新读取本机配置");
    } catch (err) {
      const message = toMessage(err);
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!form || !settings) return;
    if (!form.baseUrl.trim() && !form.apiKey.trim()) {
      // 允许官方端点 + 已有 OAuth 的情况；只做温和提示
      toast.info("当前未填写 Base URL / API Key，将使用 Claude 本机默认配置");
    }

    const draft: AgentSettingsDraft = {
      agentId: CLAUDE_ID,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey === settings.apiKey ? undefined : form.apiKey,
      defaultModel: form.defaultModel,
      modelAliases: form.modelAliases,
      permissionMode: form.permissionMode,
    };

    setSaving(true);
    try {
      const updated = await ipc.saveAgentSettings(draft);
      setSettings(updated);
      setForm(toForm(updated));
      toast.success("已写入 ~/.claude/settings.json，Claude 与 Nova 同步生效");
    } catch (err) {
      toast.error(toMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const patchForm = (patch: Partial<FormState>) =>
    setForm((current) => (current ? { ...current, ...patch } : current));

  const patchDefaultModel = (patch: Partial<AgentModelEntry>) =>
    setForm((current) =>
      current
        ? {
            ...current,
            defaultModel: { ...current.defaultModel, ...patch },
          }
        : current,
    );

  const patchAlias = (key: AgentModelAlias, patch: Partial<AgentModelEntry>) =>
    setForm((current) =>
      current
        ? {
            ...current,
            modelAliases: {
              ...current.modelAliases,
              [key]: { ...current.modelAliases[key], ...patch },
            },
          }
        : current,
    );

  return (
    <Page>
      <PageHeader
        title="Agent 配置"
        badge={
          dirty ? (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-meta font-medium text-accent">
              有未保存的修改
            </span>
          ) : (
            "本机配置"
          )
        }
        icon={<Bot className="h-4 w-4" />}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              icon={
                <RefreshCw
                  className={`h-3.5 w-3.5 ${detecting ? "animate-spin" : ""}`}
                />
              }
              onClick={refreshAgents}
              disabled={detecting}
            >
              检测 Agent
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              icon={
                <RotateCw
                  className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                />
              }
              onClick={handleReload}
              disabled={loading || selected?.id !== CLAUDE_ID}
            >
              刷新配置
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="rounded-full"
              loading={saving}
              icon={<Save className="h-3.5 w-3.5" />}
              onClick={handleSave}
              disabled={!dirty}
            >
              保存并同步
            </Button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1">
          <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface-2/30 p-3">
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-meta font-semibold tracking-wide text-text-muted">
                已检测到的 Agent
              </span>
              <span className="rounded-full bg-surface-hover px-1.5 text-caption tabular-nums text-text-muted">
                {agents.length}
              </span>
            </div>
            {agents.length === 0 ? (
              <p className="px-1 py-3 text-caption leading-relaxed text-text-muted">
                尚未检测到 Claude Code。请先安装 Claude Code。
              </p>
            ) : (
              agents.map((agent) => (
                <AgentListItem
                  key={agent.id}
                  agent={agent}
                  active={selected?.id === agent.id}
                  onClick={() => setSelectedId(agent.id)}
                />
              ))
            )}

            <div className="mt-4 rounded-lg border border-border/60 bg-surface-2/40 p-3 text-caption leading-relaxed text-text-muted">
              <p className="mb-1 font-medium text-text-secondary">共享配置</p>
              Nova 直接编辑 Claude Code 的本机配置：写入{" "}
              <code className="font-mono">~/.claude/settings.json</code>，
              MCP 写入 <code className="font-mono">~/.claude.json</code>，
              Skill 写入 <code className="font-mono">~/.claude/skills</code>。
              CLI 终端和 Nova 使用同一份配置。
            </div>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div
              ref={contentRef}
              onScroll={handleContentScroll}
              className="min-h-0 flex-1 overflow-y-auto"
            >
              <div className="mx-auto max-w-4xl space-y-4 px-section pt-section pb-6">
                {!selected ? (
                  <EmptyAgent />
                ) : loading ? (
                  <div className="flex h-60 items-center justify-center gap-2 text-body text-text-muted">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在读取 Claude 本机配置
                  </div>
                ) : loadError ? (
                  <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
                    <AlertCircle className="h-6 w-6 text-error" />
                    <p className="text-body text-error">{loadError}</p>
                    <p className="text-meta text-text-muted">
                      请先修复 ~/.claude/settings.json 后重试。
                    </p>
                    <Button variant="ghost" size="sm" onClick={handleReload}>
                      重新读取
                    </Button>
                  </div>
                ) : form && settings ? (
                  <>
                    {!selected.status.installed && (
                      <InstallCard
                        agent={selected}
                        onCopy={handleCopyInstall}
                        onDetect={refreshAgents}
                        detecting={detecting}
                      />
                    )}

                    <AgentStatusCard
                      agent={selected}
                      form={form}
                      hasApiKey={settings.hasApiKey}
                    />

                    <nav className="ui-glass-strong ui-ring sticky top-0 z-20 flex flex-wrap items-center gap-1 rounded-xl p-1">
                      {SECTION_NAV.map((item) => {
                        const active = activeSection === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => scrollToSection(item.id)}
                            className={`rounded-lg px-3 py-1.5 text-meta font-medium transition-colors ${
                              active
                                ? "bg-surface text-text shadow-[var(--c-shadow-sm)]"
                                : "text-text-muted hover:text-text"
                            }`}
                          >
                            {item.label}
                          </button>
                        );
                      })}
                    </nav>

                    <SectionCard
                      id="agent-connection"
                      title="连接配置"
                      description="写入 Claude 本机 settings.json；Base URL 与 Key 同时供 Claude CLI 与 Nova 使用。"
                      icon={KeyRound}
                    >
                      <div className="space-y-4">
                        <Field
                          label="Base URL"
                          hint="留空使用 Anthropic 官方端点；使用第三方兼容服务时填写其根地址。"
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
                          hint="官方端点写入 ANTHROPIC_API_KEY，自定义端点写入 ANTHROPIC_AUTH_TOKEN；保存时按端点类型自动归位。"
                        >
                          <div className="relative">
                            <input
                              type={showKey ? "text" : "password"}
                              value={form.apiKey}
                              onChange={(event) =>
                                patchForm({ apiKey: event.target.value })
                              }
                              placeholder={
                                settings.hasApiKey
                                  ? "已配置 API Key"
                                  : "未配置 API Key"
                              }
                              spellCheck={false}
                              autoComplete="off"
                              className={`${FORM_INPUT_CLASS} pr-12`}
                            />
                            <button
                              type="button"
                              onClick={() => setShowKey((value) => !value)}
                              title={showKey ? "隐藏密钥" : "显示密钥"}
                              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
                            >
                              {showKey ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </button>
                          </div>
                        </Field>

                        <Field
                          label="默认模型"
                          hint={`写入 ANTHROPIC_MODEL；${modelListHint}`}
                        >
                          <div className="flex items-center gap-2">
                            <Combobox
                              value={form.defaultModel.name}
                              onChange={(name) => patchDefaultModel({ name })}
                              options={modelNameOptions}
                              onOpen={refreshModelList}
                              placeholder="选择或输入模型名"
                              aria-label="默认模型名称"
                              className="min-w-0 flex-1"
                            />
                            <Select
                              value={form.defaultModel.context}
                              onChange={(context) =>
                                patchDefaultModel({ context })
                              }
                              options={contextOptions(form.defaultModel.context)}
                              aria-label="默认模型上下文"
                              className={`${SPLIT_INPUT_CLASS} w-28 shrink-0`}
                              minMenuWidth={120}
                            />
                          </div>
                        </Field>
                      </div>
                    </SectionCard>

                    <SectionCard
                      id="agent-models"
                      title="模型配置"
                      description="模型名与上下文分列选择；上下文（如 1M）会以 [1M] 形式追加到模型 ID。"
                      icon={Sparkles}
                      action={
                        <span
                          title="按基础模型名去重"
                          className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-meta font-medium text-accent"
                        >
                          已配置 {liveModelCount} 个模型
                        </span>
                      }
                    >
                      <div className="space-y-4">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {MODEL_ALIASES.map((alias) => (
                            <Field
                              key={alias.key}
                              label={alias.label}
                              hint={`${alias.hint} · 模型名 / 上下文`}
                            >
                              <div className="flex items-center gap-2">
                                <Combobox
                                  value={form.modelAliases[alias.key].name}
                                  onChange={(name) =>
                                    patchAlias(alias.key, { name })
                                  }
                                  options={modelNameOptions}
                                  onOpen={refreshModelList}
                                  placeholder="模型名"
                                  aria-label={`${alias.label} 模型名称`}
                                  className="min-w-0 flex-1"
                                />
                                <Select
                                  value={form.modelAliases[alias.key].context}
                                  onChange={(context) =>
                                    patchAlias(alias.key, { context })
                                  }
                                  options={contextOptions(
                                    form.modelAliases[alias.key].context,
                                  )}
                                  aria-label={`${alias.label} 上下文`}
                                  className={`${SPLIT_INPUT_CLASS} w-24 shrink-0`}
                                  minMenuWidth={120}
                                />
                              </div>
                            </Field>
                          ))}
                        </div>
                        <p className="text-caption leading-relaxed text-text-muted">
                          模型名写入 <code className="font-mono">_MODEL_NAME</code>；
                          上下文会追加到 <code className="font-mono">_MODEL</code>，
                          例如 <code className="font-mono">deepseek-flash[1M]</code>。
                          留空会移除对应配置。
                        </p>
                      </div>
                    </SectionCard>

                    <SectionCard
                      id="agent-permission"
                      title="默认权限"
                      description="写入 settings.json 的 permissions.defaultMode；终端 claude、Nova 会话与工作流节点统一按此配置运行。无人值守运行建议使用 bypassPermissions。"
                      icon={ShieldCheck}
                    >
                      <Field label="权限模式">
                        <Select
                          value={form.permissionMode}
                          onChange={(value) =>
                            patchForm({ permissionMode: value })
                          }
                          className={FORM_INPUT_CLASS}
                          minMenuWidth={280}
                          options={permissionOptions}
                        />
                      </Field>
                    </SectionCard>

                    <SectionCard
                      id="agent-file"
                      title="配置文件"
                      description="Claude Code 与 Nova 共用同一份本机配置；保存后会直接写回该文件。"
                      icon={FolderOpen}
                    >
                      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-input-bg px-3 py-2.5 text-caption text-text-muted">
                        <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                        <span
                          title={settings.settingsPath}
                          className="min-w-0 flex-1 break-all font-mono text-caption leading-relaxed"
                        >
                          {settings.settingsPath}
                        </span>
                        <button
                          type="button"
                          onClick={handleOpenConfig}
                          disabled={opening}
                          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-meta text-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
                        >
                          {opening ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <FolderOpen className="h-3.5 w-3.5" />
                          )}
                          <span className="text-accent">打开所在目录</span>
                        </button>
                      </div>
                      <p className="mt-2 text-caption leading-relaxed text-text-muted">
                        {settings.exists
                          ? "修改会直接写回该文件；Claude CLI 与 Nova 共用同一份配置。"
                          : "配置文件尚未创建，保存后会自动生成。"}
                      </p>
                    </SectionCard>
                  </>
                ) : null}
              </div>
            </div>

          </section>
        </div>
    </Page>
  );
}

// ============================================================================
// 子组件
// ============================================================================

function AgentStatusCard({
  agent,
  form,
  hasApiKey,
}: {
  agent: AgentInfo;
  form: FormState;
  hasApiKey: boolean;
}) {
  const hasCustomEndpoint = form.baseUrl.trim() !== "";
  const modelLabel = form.defaultModel.name
    ? `${form.defaultModel.name}${
        form.defaultModel.context ? ` [${form.defaultModel.context}]` : ""
      }`
    : "跟随默认";

  return (
    <section className="relative overflow-hidden rounded-2xl border border-border/70 bg-surface-2/40 p-5">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/18 via-accent/[0.04] to-transparent"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-28 h-64 w-64 rounded-full bg-accent/20 blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent"
      />

      <div className="relative flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground shadow-[0_8px_24px_var(--c-accent-soft)]">
            <Bot className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-heading font-semibold tracking-tight text-text">
                {agent.displayName}
              </h2>
              <span
                className={`rounded-full px-2 py-0.5 text-caption font-medium ${
                  agent.status.installed
                    ? "bg-success/10 text-success"
                    : "bg-error-bg text-error"
                }`}
              >
                {agent.status.installed ? "已安装" : "未安装"}
              </span>
            </div>
            <p className="mt-0.5 truncate text-meta text-text-muted">
              {agent.status.version ? `版本 ${agent.status.version} · ` : ""}
              配置与 Claude CLI 共用
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-3">
          <StatusMetric
            label="端点"
            value={hasCustomEndpoint ? "自定义" : "官方默认"}
          />
          <StatusMetric
            label="API Key"
            value={hasApiKey ? "已配置" : "未配置"}
            tone={hasApiKey ? "success" : "muted"}
          />
          <StatusMetric label="默认模型" value={modelLabel} />
          <StatusMetric label="权限模式" value={form.permissionMode} />
        </div>
      </div>
    </section>
  );
}

function StatusMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "muted";
}) {
  return (
    <div className="min-w-0">
      <div className="text-caption text-text-muted">{label}</div>
      <div
        className={`mt-0.5 max-w-[150px] truncate text-body font-medium ${
          tone === "success"
            ? "text-success"
            : tone === "muted"
              ? "text-text-muted"
              : "text-text"
        }`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function SectionCard({
  id,
  title,
  description,
  icon: Icon,
  action,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-14 rounded-xl border border-border/70 bg-surface-2/40 p-5 shadow-[var(--c-shadow-sm)]"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-body font-semibold text-text">{title}</h2>
            {description && (
              <p className="mt-0.5 text-meta leading-relaxed text-text-muted">
                {description}
              </p>
            )}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function InstallCard({
  agent,
  onCopy,
  onDetect,
  detecting,
}: {
  agent: AgentInfo;
  onCopy: () => void;
  onDetect: () => void;
  detecting: boolean;
}) {
  return (
    <section className="rounded-xl border border-error/40 bg-error-bg/30 p-card">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-error" />
        <div className="min-w-0 flex-1">
          <h2 className="text-body font-semibold text-text">
            未检测到 {agent.displayName}
          </h2>
          <p className="mt-1 text-meta leading-relaxed text-text-secondary">
            请先在终端执行安装命令，安装完成后回到这里点击「检测 Agent」。
          </p>
          {agent.installCommand ? (
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-input-bg px-inset py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-meta text-text">
                {agent.installCommand}
              </code>
              <button
                type="button"
                onClick={onCopy}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-meta text-accent transition-colors hover:bg-accent-soft"
              >
                <Copy className="h-3.5 w-3.5" />
                复制
              </button>
            </div>
          ) : (
            <p className="mt-2 text-meta text-text-muted">
              请参考该 Agent 的官方文档完成安装。
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              icon={
                <RefreshCw
                  className={`h-3.5 w-3.5 ${detecting ? "animate-spin" : ""}`}
                />
              }
              onClick={onDetect}
              disabled={detecting}
            >
              检测 Agent
            </Button>
            <span className="text-caption text-text-muted">
              若已安装仍检测不到，请重启 Nova 以刷新 PATH。
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function AgentListItem({
  agent,
  active,
  onClick,
}: {
  agent: AgentInfo;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-1 flex w-full items-center gap-2 rounded-xl border px-2.5 py-2.5 text-left transition-colors ${
        active
          ? "border-accent/30 bg-accent-soft"
          : "border-transparent hover:bg-surface-hover"
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
          active ? "bg-accent/10 text-accent" : "bg-surface-hover text-text-muted"
        }`}
      >
        <Bot className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-lg font-medium text-text">
          {agent.displayName}
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5">
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-caption font-medium ${
              agent.status.installed
                ? "bg-success/10 text-success"
                : "bg-error-bg text-error"
            }`}
          >
            {agent.status.installed ? "已安装" : "未安装"}
          </span>
          {agent.status.installed && agent.status.version && (
            <span className="min-w-0 truncate text-caption text-text-muted">
              {agent.status.version}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function EmptyAgent() {
  return (
    <EmptyState
      size="compact"
      icon={<Terminal />}
      title="没有可展示的 Claude Code"
      description="安装 Claude Code 后点击「检测 Agent」。"
    />
  );
}
