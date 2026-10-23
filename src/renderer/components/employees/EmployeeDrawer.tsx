/**
 * 数字员工编辑抽屉
 *
 * 从右侧滑出，按「基本资料 / 系统提示词 / MCP / 技能」分标签编辑。
 * 新建与编辑共用同一份草稿状态；保存时才写入 SQLite。
 *
 * 头像在渲染进程读取：经 canvas 裁剪为 256×256 的 WebP data URL，
 * 避免把原图整张塞进数据库。
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Check,
  Eraser,
  Loader2,
  Lock,
  MessageSquareText,
  Plug,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { useSkillFontSize } from "../../hooks/useTheme";
import { newId } from "../../lib/utils";
import { Modal, ModalHeader } from "../ui/Modal";
import { ModelSelect } from "../ui/ModelSelect";
import { EmployeeAvatar } from "./EmployeeAvatar";
import type { AgentInfo } from "@shared/contracts/agent";
import type {
  DigitalEmployee,
  DigitalEmployeeDraft,
  EmployeeMcpServer,
  EmployeeSkill,
  SkillAsset,
  SkillOrigin,
} from "@shared/types";

// ============================================================================
// 常量与类型
// ============================================================================

type TabId = "profile" | "prompt" | "mcp" | "skills";

const TABS: ReadonlyArray<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: "profile", label: "基本资料", icon: UserRound },
  { id: "prompt", label: "系统提示词", icon: MessageSquareText },
  { id: "mcp", label: "MCP 服务", icon: Plug },
  { id: "skills", label: "技能", icon: Sparkles },
];

const INPUT_CLASS =
  "ui-ring w-full rounded-lg bg-input-bg px-inset py-inset text-body text-text placeholder-text-muted outline-none transition-colors focus:border-input-border-focus";

const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

/** 草稿默认值：优先绑定第一个已安装的 Agent */
function emptyDraft(agents: AgentInfo[]): DigitalEmployeeDraft {
  const firstAgent = agents.find((agent) => agent.status.installed) ?? agents[0];
  return {
    name: "",
    role: "",
    description: "",
    avatar: null,
    agentId: firstAgent?.id ?? "",
    model: "",
    systemPrompt: "",
    mcpServers: [],
    skills: [],
    enabled: true,
  };
}

/** 持久化对象 → 可编辑草稿 */
function toDraft(employee: DigitalEmployee): DigitalEmployeeDraft {
  return {
    name: employee.name,
    role: employee.role,
    description: employee.description,
    avatar: employee.avatar,
    agentId: employee.agentId,
    model: employee.model,
    systemPrompt: employee.systemPrompt,
    mcpServers: employee.mcpServers,
    skills: employee.skills,
    enabled: employee.enabled,
  };
}

// ============================================================================
// 主组件
// ============================================================================

interface EmployeeDrawerProps {
  /** null 表示新建 */
  employee: DigitalEmployee | null;
  agents: AgentInfo[];
  onClose: () => void;
  /** 保存 / 删除成功后刷新列表 */
  onSaved: () => void | Promise<void>;
}

export function EmployeeDrawer({
  employee,
  agents,
  onClose,
  onSaved,
}: EmployeeDrawerProps) {
  const [draft, setDraft] = useState<DigitalEmployeeDraft>(() =>
    employee ? toDraft(employee) : emptyDraft(agents),
  );
  const [tab, setTab] = useState<TabId>("profile");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const avatarInputRef = useRef<HTMLInputElement>(null);

  const update = (fields: Partial<DigitalEmployeeDraft>) =>
    setDraft((current) => ({ ...current, ...fields }));

  // Agent 检测是异步的：打开抽屉时可能还没拿到候选列表。
  // 列表到达后补上默认 Agent，避免保存出「未绑定 Agent」的档案。
  useEffect(() => {
    if (draft.agentId || agents.length === 0) return;
    const first = agents.find((agent) => agent.status.installed) ?? agents[0];
    if (first) setDraft((current) => ({ ...current, agentId: first.id }));
  }, [agents, draft.agentId]);

  const handleAvatarFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("请选择图片文件");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError("头像图片不能超过 8MB");
      return;
    }
    try {
      update({ avatar: await resizeImage(file, 256) });
      setError(null);
    } catch {
      setError("头像读取失败，请换一张图片重试");
    }
  };

  const handleSave = async () => {
    const name = draft.name.trim();
    if (!name || saving) return;

    setSaving(true);
    setError(null);
    try {
      const payload = { ...draft, name };
      if (employee) await ipc.updateEmployee(employee.id, payload);
      else await ipc.createEmployee(payload);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!employee) return;
    if (!window.confirm(`删除数字员工「${employee.name}」？此操作不可恢复。`)) return;

    try {
      await ipc.deleteEmployee(employee.id);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      onClick={onClose}
      role="presentation"
    >
      <div className="absolute inset-0 bg-bg/40 backdrop-blur-sm" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={employee ? "编辑数字员工" : "新建数字员工"}
        className="ui-glass-strong relative flex h-full w-[680px] max-w-[94vw] flex-col border-l border-border-strong shadow-[var(--c-shadow)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 头部：当前员工身份 */}
        <div className="flex h-[var(--c-layout-header)] shrink-0 items-center gap-3 border-b border-border px-card">
          <EmployeeAvatar employee={draft} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-body-lg font-semibold text-text">
                {draft.name.trim() || (employee ? "未命名员工" : "新建数字员工")}
              </span>
              {!draft.enabled && (
                <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-caption text-text-muted">
                  已停用
                </span>
              )}
            </div>
            <div className="truncate text-caption text-text-muted">
              {draft.role.trim() || "数字员工"}
            </div>
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

        {/* 标签栏 */}
        <div className="ui-scroll-hidden flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            const count =
              id === "mcp"
                ? draft.mcpServers.length
                : id === "skills"
                  ? draft.skills.length
                  : 0;

            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-meta transition-colors ${
                  active ? "text-accent" : "text-text-muted hover:text-text"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                {count > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-micro font-medium ${
                      active
                        ? "bg-accent-soft text-accent"
                        : "bg-surface-hover text-text-muted"
                    }`}
                  >
                    {count}
                  </span>
                )}
                {active && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
                )}
              </button>
            );
          })}
        </div>

        {/* 标签内容 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-section py-card">
          {tab === "profile" && (
            <ProfileTab
              draft={draft}
              agents={agents}
              update={update}
              onPickAvatar={() => avatarInputRef.current?.click()}
            />
          )}
          {tab === "prompt" && (
            <PromptTab
              value={draft.systemPrompt}
              onChange={(systemPrompt) => update({ systemPrompt })}
            />
          )}
          {tab === "mcp" && (
            <McpTab
              servers={draft.mcpServers}
              onChange={(mcpServers) => update({ mcpServers })}
            />
          )}
          {tab === "skills" && (
            <SkillsTab
              skills={draft.skills}
              agentId={draft.agentId}
              agentLabel={
                agents.find((agent) => agent.id === draft.agentId)?.displayName ??
                draft.agentId
              }
              onChange={(skills) => update({ skills })}
            />
          )}
        </div>

        {/* 底部：删除 / 取消 / 保存 */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-card py-3">
          <div className="min-w-0">
            {employee && (
              <button
                type="button"
                onClick={handleDelete}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-meta text-error transition-colors hover:bg-error-bg"
              >
                <Trash2 className="h-4 w-4" />
                删除员工
              </button>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {error && (
              <span className="max-w-56 truncate text-caption text-error" title={error}>
                {error}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="ui-btn-ghost rounded-lg px-4 py-2 text-body"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!draft.name.trim() || saving}
              className="ui-btn-primary flex items-center gap-1.5 rounded-lg px-4 py-2 text-body font-medium"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              保存
            </button>
          </div>
        </div>

        {/* 隐藏的文件选择器 */}
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void handleAvatarFile(file);
          }}
        />
      </div>
    </div>
  );
}

// ============================================================================
// 基本资料
// ============================================================================

function ProfileTab({
  draft,
  agents,
  update,
  onPickAvatar,
}: {
  draft: DigitalEmployeeDraft;
  agents: AgentInfo[];
  update: (fields: Partial<DigitalEmployeeDraft>) => void;
  onPickAvatar: () => void;
}) {
  return (
    <div className="space-y-5">
      {/* 头像 */}
      <div className="flex flex-wrap items-center gap-4">
        <EmployeeAvatar employee={draft} size={72} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onPickAvatar}
              className="ui-btn-ghost flex items-center gap-1.5 rounded-lg px-3 py-2 text-meta"
            >
              <Upload className="h-3.5 w-3.5" />
              上传头像
            </button>
            {draft.avatar && (
              <button
                type="button"
                onClick={() => update({ avatar: null })}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-meta text-text-muted transition-colors hover:bg-surface-hover hover:text-error"
              >
                <Eraser className="h-3.5 w-3.5" />
                移除
              </button>
            )}
          </div>
          <p className="mt-1.5 text-caption leading-relaxed text-text-muted">
            建议使用正方形图片，上传后会自动裁剪为 256×256。
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="名称" required>
          <input
            value={draft.name}
            onChange={(event) => update({ name: event.target.value })}
            placeholder="例如：小助手"
            className={INPUT_CLASS}
            autoFocus
          />
        </Field>
        <Field label="职位 / 角色">
          <input
            value={draft.role}
            onChange={(event) => update({ role: event.target.value })}
            placeholder="例如：产品分析师"
            className={INPUT_CLASS}
          />
        </Field>
      </div>

      <Field label="简介" hint="一句话说明这位员工擅长什么，会展示在卡片上。">
        <textarea
          value={draft.description}
          onChange={(event) => update({ description: event.target.value })}
          rows={2}
          placeholder="例如：负责竞品分析、用户研究与需求拆解"
          className={`${INPUT_CLASS} resize-y leading-relaxed`}
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="执行 Agent" hint="数字员工复用该 Agent 的运行时与工具生态。">
          <select
            value={draft.agentId}
            onChange={(event) =>
              // 换 Agent 后旧模型名很可能不再有效，一并清空
              update({ agentId: event.target.value, model: "" })
            }
            className={INPUT_CLASS}
          >
            {agents.length === 0 && (
              <option value={draft.agentId}>
                {draft.agentId || "未检测到 Agent"}
              </option>
            )}
            {agents.map((agent) => (
              <option
                key={agent.id}
                value={agent.id}
                disabled={!agent.status.installed}
              >
                {agent.displayName}
                {agent.status.installed
                  ? agent.status.version
                    ? ` v${agent.status.version}`
                    : ""
                  : "（未安装）"}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="模型"
          hint="列表会自动从所选 Agent 获取；留空则由 Agent 自己决定。"
        >
          <ModelSelect
            agentId={draft.agentId}
            value={draft.model}
            onChange={(model) => update({ model })}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2/40 px-3 py-2.5">
        <div>
          <div className="text-body text-text">启用状态</div>
          <div className="text-caption text-text-muted">
            停用后仍保留配置，但不会出现在可分配列表中。
          </div>
        </div>
        <Toggle
          checked={draft.enabled}
          onChange={(enabled) => update({ enabled })}
          label="启用状态"
        />
      </div>
    </div>
  );
}

// ============================================================================
// 系统提示词
// ============================================================================

function PromptTab({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-surface-2/40 px-3 py-2.5 text-meta leading-relaxed text-text-secondary">
        系统提示词定义员工的身份、职责与行为边界，会作为每次对话的基础设定。
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={16}
        placeholder={
          "例如：\n你是一名资深产品分析师。\n- 先澄清目标，再给出结论\n- 输出结构化、可执行的分析"
        }
        className={`${INPUT_CLASS} min-h-[320px] resize-y font-mono text-meta leading-relaxed`}
      />
      <div className="text-right text-caption text-text-muted">
        {value.length} 字符
      </div>
    </div>
  );
}

// ============================================================================
// MCP 服务
// ============================================================================

function McpTab({
  servers,
  onChange,
}: {
  servers: EmployeeMcpServer[];
  onChange: (servers: EmployeeMcpServer[]) => void;
}) {
  const updateServer = (id: string, fields: Partial<EmployeeMcpServer>) =>
    onChange(servers.map((server) => (server.id === id ? { ...server, ...fields } : server)));

  const addServer = () =>
    onChange([
      ...servers,
      {
        id: newId(),
        name: "",
        command: "npx",
        args: "",
        env: "",
        enabled: true,
      },
    ]);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-meta leading-relaxed text-text-muted">
          配置这位员工可以调用的 MCP 服务。停用的服务不会注入运行时。
        </p>
        <button
          type="button"
          onClick={addServer}
          className="ui-btn-primary flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-meta font-medium"
        >
          <Plus className="h-3.5 w-3.5" />
          添加服务
        </button>
      </div>

      {servers.length === 0 ? (
        <EmptyTab
          icon={Plug}
          text="还没有配置 MCP 服务"
          hint="添加后，员工即可调用对应的外部工具。"
        />
      ) : (
        <div className="space-y-3">
          {servers.map((server) => (
            <div
              key={server.id}
              className={`rounded-lg border border-border bg-surface-2/40 p-3 ${
                server.enabled ? "" : "opacity-65"
              }`}
            >
              <div className="flex items-center gap-2">
                <Toggle
                  checked={server.enabled}
                  onChange={(enabled) => updateServer(server.id, { enabled })}
                  label="启用 MCP 服务"
                />
                <input
                  value={server.name}
                  onChange={(event) =>
                    updateServer(server.id, { name: event.target.value })
                  }
                  placeholder="服务名称，如 filesystem"
                  className={`${INPUT_CLASS} font-medium`}
                />
                <button
                  type="button"
                  onClick={() =>
                    onChange(servers.filter((item) => item.id !== server.id))
                  }
                  title="删除服务"
                  className="shrink-0 rounded-lg p-2 text-text-muted transition-colors hover:bg-error-bg hover:text-error"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  value={server.command}
                  onChange={(event) =>
                    updateServer(server.id, { command: event.target.value })
                  }
                  placeholder="命令，如 npx"
                  className={`${INPUT_CLASS} font-mono text-meta`}
                />
                <input
                  value={server.args}
                  onChange={(event) =>
                    updateServer(server.id, { args: event.target.value })
                  }
                  placeholder="参数，如 -y @modelcontextprotocol/server-filesystem"
                  className={`${INPUT_CLASS} font-mono text-meta`}
                />
              </div>

              <textarea
                value={server.env}
                onChange={(event) =>
                  updateServer(server.id, { env: event.target.value })
                }
                rows={2}
                placeholder="环境变量，每行 KEY=VALUE（可选）"
                className={`${INPUT_CLASS} mt-2 resize-y font-mono text-meta`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 技能
// ============================================================================

const SKILL_ORIGIN_LABEL: Record<SkillOrigin, string> = {
  library: "Nova 技能库",
  "claude-global": "Claude 全局",
  "agents-store": "共享技能库",
};

const SKILL_ORIGIN_CLASS: Record<SkillOrigin, string> = {
  library: "bg-accent-soft text-accent",
  "claude-global": "bg-agent-violet/10 text-agent-violet",
  "agents-store": "bg-agent-teal/10 text-agent-teal",
};

function SkillsTab({
  skills,
  agentId,
  agentLabel,
  onChange,
}: {
  skills: EmployeeSkill[];
  agentId: string;
  agentLabel: string;
  onChange: (skills: EmployeeSkill[]) => void;
}) {
  // 技能标签页同样使用放大后的字号，避免来源标签与路径看不清
  const skillFontSize = useSkillFontSize();
  const [catalog, setCatalog] = useState<SkillAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    ipc
      .listSkills()
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
  const boundIds = new Set(skills.map((skill) => skill.assetId).filter(Boolean));

  const toggleSkill = (index: number, enabled: boolean) =>
    onChange(skills.map((skill, i) => (i === index ? { ...skill, enabled } : skill)));

  const removeSkill = (index: number) =>
    onChange(skills.filter((_, i) => i !== index));

  const addSkill = (asset: SkillAsset) => {
    if (boundIds.has(asset.id)) return;
    onChange([...skills, { assetId: asset.id, name: asset.name, enabled: true }]);
  };

  const unsupported =
    agentId !== "" && agentId !== "claude" && skills.some((skill) => skill.enabled);

  return (
    <div
      className="space-y-3"
      style={{ "--c-font-size": `${skillFontSize}px` } as CSSProperties}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-body leading-relaxed text-text-muted">
          从技能库勾选这位员工可使用的技能。技能内容统一在「Skill 技能」页面管理，
          这里只保存引用，修改技能时所有员工同时生效。
        </p>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="ui-btn-primary flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-body font-medium"
        >
          <Plus className="h-3.5 w-3.5" />
          添加技能
        </button>
      </div>

      {unsupported && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/60 p-3 text-meta leading-relaxed text-text-muted">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-agent-amber" />
          <span>
            当前绑定的 Agent（{agentLabel}）暂未实现技能注入。技能会正常保存，
            但运行工作流时不会生效；如需使用技能，请把员工绑定到 Claude Code。
          </span>
        </div>
      )}

      {loadError && (
        <div className="rounded-lg border border-error/40 bg-error-bg p-3 text-meta text-error">
          技能库加载失败：{loadError}
        </div>
      )}

      {skills.length === 0 ? (
        <EmptyTab
          icon={Sparkles}
          text="还没有绑定技能"
          hint="从技能库选择后，员工可以在合适的时候自动调用。"
        />
      ) : (
        <div className="space-y-2">
          {skills.map((skill, index) => {
            const asset = skill.assetId ? byId.get(skill.assetId) : undefined;
            const legacy = !skill.assetId;
            const missing = !legacy && !asset && !loading;
            const problems = asset && !asset.valid ? asset.problems : [];
            const key = skill.assetId || skill.source || `skill-${index}`;

            return (
              <div
                key={key}
                className={`rounded-lg border border-border bg-surface-2/40 p-3 ${
                  skill.enabled ? "" : "opacity-65"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={skill.enabled}
                    onChange={(enabled) => toggleSkill(index, enabled)}
                    label="启用技能"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-body-lg font-medium text-text">
                        {asset?.name || skill.name}
                      </span>
                      {asset && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${SKILL_ORIGIN_CLASS[asset.origin]}`}
                        >
                          {SKILL_ORIGIN_LABEL[asset.origin]}
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
                      {legacy && (
                        <span className="shrink-0 rounded-full bg-agent-amber/10 px-2 py-0.5 text-caption text-agent-amber">
                          旧版路径
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
                      title={asset?.path || skill.source || undefined}
                      className="mt-0.5 truncate font-mono text-meta text-text-muted"
                    >
                      {asset?.path || skill.source || "—"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeSkill(index)}
                    title="从员工中移除"
                    className="shrink-0 rounded-lg p-2 text-text-muted transition-colors hover:bg-error-bg hover:text-error"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {missing && (
                  <p className="mt-1.5 text-meta leading-relaxed text-error">
                    技能资产已不存在（可能从未入库或已被删除）。请移除后从技能库重新选择。
                  </p>
                )}
                {legacy && (
                  <p className="mt-1.5 text-meta leading-relaxed text-text-muted">
                    旧版路径技能：运行时仍按原路径注入，建议移除后从技能库重新绑定，
                    以便统一管理与校验。
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

      <SkillPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        catalog={catalog}
        loading={loading}
        query={query}
        onQueryChange={setQuery}
        boundIds={boundIds}
        onAdd={addSkill}
      />
    </div>
  );
}

// ============================================================================
// 技能选择器
// ============================================================================

function SkillPicker({
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
  catalog: SkillAsset[];
  loading: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  boundIds: Set<string>;
  onAdd: (asset: SkillAsset) => void;
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
        <ModalHeader title="从技能库添加" onClose={onClose} className="mb-2" />

        <p className="mb-3 text-meta leading-relaxed text-text-muted">
          只读来源同样可以绑定，运行时会被复制到独立配置目录。
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
              正在扫描技能库
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-body text-text-muted">
              {catalog.length === 0
                ? "技能库还是空的，请先在「Skill 技能」页面导入技能。"
                : "没有匹配的技能"}
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
                        className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${SKILL_ORIGIN_CLASS[asset.origin]}`}
                      >
                        {SKILL_ORIGIN_LABEL[asset.origin]}
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

// ============================================================================
// 通用小件
// ============================================================================

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1 text-caption font-medium text-text-secondary">
        {label}
        {required && <span className="text-error">*</span>}
      </div>
      {children}
      {hint && (
        <p className="mt-1 text-caption leading-relaxed text-text-muted">{hint}</p>
      )}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={checked ? "已启用" : "已停用"}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border px-0.5 transition-colors ${
        checked
          ? "border-accent bg-accent"
          : "border-border-strong bg-surface-hover"
      }`}
    >
      {/* 用 flex 布局定位滑块，避免 absolute 的静态位置受按钮 text-align 影响 */}
      <span
        className={`h-3.5 w-3.5 rounded-full shadow-[var(--c-shadow-sm)] transition-transform ${
          checked
            ? "translate-x-4 bg-accent-foreground"
            : "translate-x-0 bg-text-secondary"
        }`}
      />
    </button>
  );
}

function EmptyTab({
  icon: Icon,
  text,
  hint,
}: {
  icon: LucideIcon;
  text: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-surface-2/30 px-6 py-14 text-center text-text-muted">
      <Icon className="h-7 w-7 opacity-50" />
      <p className="text-body text-text-secondary">{text}</p>
      {hint && <p className="text-caption">{hint}</p>}
    </div>
  );
}

// ============================================================================
// 文件处理
// ============================================================================

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解码失败"));
    image.src = src;
  });
}

/**
 * 把图片居中裁剪为正方形并压缩成 WebP data URL。
 * 头像只需要展示用的尺寸，存原图会让数据库迅速膨胀。
 */
async function resizeImage(file: File, size: number): Promise<string> {
  const source = await readAsDataUrl(file);
  const image = await loadImage(source);

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");
  if (!context) return source;

  const scale = Math.max(size / image.width, size / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  context.drawImage(
    image,
    (size - width) / 2,
    (size - height) / 2,
    width,
    height,
  );

  return canvas.toDataURL("image/webp", 0.85);
}
