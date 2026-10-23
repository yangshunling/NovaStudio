/**
 * 数字员工编辑抽屉
 *
 * 从右侧滑出，按「基本资料 / 系统提示词 / MCP / 技能」分标签编辑。
 * 新建与编辑共用同一份草稿状态；保存时才写入 SQLite。
 *
 * 头像在渲染进程读取：经 canvas 裁剪为 256×256 的 WebP data URL，
 * 避免把原图整张塞进数据库。
 */

import { useEffect, useRef, useState } from "react";
import {
  Eraser,
  Library,
  Loader2,
  MessageSquareText,
  Plug,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { Field, FORM_INPUT_CLASS as INPUT_CLASS } from "../ui/Field";
import { ModelSelect } from "../ui/ModelSelect";
import { EmployeeAvatar } from "./EmployeeAvatar";
import { KnowledgeTab } from "./knowledge/KnowledgeTab";
import { McpTab } from "./mcp/McpTab";
import { SkillsTab } from "./skills/SkillsTab";
import { Toggle } from "./ui";
import type { AgentInfo } from "@shared/contracts/agent";
import type { DigitalEmployee, DigitalEmployeeDraft } from "@shared/types";

// ============================================================================
// 常量与类型
// ============================================================================

type TabId = "profile" | "prompt" | "mcp" | "skills" | "knowledge";

const TABS: ReadonlyArray<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: "profile", label: "基本资料", icon: UserRound },
  { id: "prompt", label: "系统提示词", icon: MessageSquareText },
  { id: "mcp", label: "MCP 服务", icon: Plug },
  { id: "skills", label: "技能", icon: Sparkles },
  { id: "knowledge", label: "知识库", icon: Library },
];

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
    knowledgeBases: [],
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
    knowledgeBases: employee.knowledgeBases ?? [],
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

  const activeAgent = agents.find((agent) => agent.id === draft.agentId) ?? null;
  const agentLabel = activeAgent?.displayName ?? draft.agentId;
  const supportsSkills = activeAgent?.capabilities.skills ?? false;
  const supportsMcp = activeAgent?.capabilities.mcp ?? false;

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
                  : id === "knowledge"
                    ? draft.knowledgeBases.length
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
              agentLabel={agentLabel}
              supportsMcp={supportsMcp}
              onChange={(mcpServers) => update({ mcpServers })}
            />
          )}
          {tab === "skills" && (
            <SkillsTab
              skills={draft.skills}
              agentLabel={agentLabel}
              supportsSkills={supportsSkills}
              onChange={(skills) => update({ skills })}
            />
          )}
          {tab === "knowledge" && (
            <KnowledgeTab
              bases={draft.knowledgeBases}
              onChange={(knowledgeBases) => update({ knowledgeBases })}
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
