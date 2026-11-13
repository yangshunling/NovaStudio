/**
 * 数字员工编辑抽屉
 *
 * 从右侧滑出，按「基本资料 / MCP / 技能 / 知识库」分标签编辑。
 * 系统提示词属于基本资料（不做单独标签页）。
 * 新建与编辑共用同一份草稿状态；保存时才写入 SQLite。
 *
 * 头像在渲染进程读取：经 canvas 裁剪为 256×256 的 WebP data URL，
 * 避免把原图整张塞进数据库。
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  Eraser,
  Library,
  Plug,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { confirmDialog } from "../../stores/confirm";
import { EMPLOYEE_SESSION_IN_USE } from "@shared/contracts/ipc";
import {
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerFooter,
  DrawerHeader,
} from "../ui/Drawer";
import { Button } from "../ui/Button";
import { SegmentedTabs } from "../ui/SegmentedTabs";
import { Field, FORM_INPUT_CLASS as INPUT_CLASS } from "../ui/Field";
import { EmployeeAvatar } from "./EmployeeAvatar";
import { KnowledgeTab } from "./knowledge/KnowledgeTab";
import { McpTab } from "./mcp/McpTab";
import { SkillsTab } from "./skills/SkillsTab";
import { toEmployeeDraft } from "../../lib/employee-draft";
import type { DigitalEmployee, DigitalEmployeeDraft } from "@shared/types";
import { errorMessage } from "@shared/error";

// ============================================================================
// 常量与类型
// ============================================================================

type TabId = "profile" | "mcp" | "skills" | "knowledge";

const TABS: ReadonlyArray<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: "profile", label: "基本资料", icon: UserRound },
  { id: "mcp", label: "MCP 服务", icon: Plug },
  { id: "skills", label: "技能", icon: Sparkles },
  { id: "knowledge", label: "知识库", icon: Library },
];

const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

/** 草稿默认值 */
function emptyDraft(): DigitalEmployeeDraft {
  return {
    name: "",
    role: "",
    description: "",
    avatar: null,
    systemPrompt: "",
    mcpServers: [],
    skills: [],
    knowledgeBases: [],
    enabled: true,
  };
}

// ============================================================================
// 主组件
// ============================================================================

interface EmployeeDrawerProps {
  /** null 表示新建 */
  employee: DigitalEmployee | null;
  onClose: () => void;
  /** 保存 / 删除成功后刷新列表 */
  onSaved: () => void | Promise<void>;
}

export function EmployeeDrawer({
  employee,
  onClose,
  onSaved,
}: EmployeeDrawerProps) {
  /** 打开抽屉时的快照：用于判断草稿是否真的有改动 */
  const initialDraft = useRef<DigitalEmployeeDraft>(
    employee ? toEmployeeDraft(employee) : emptyDraft(),
  );
  const [draft, setDraft] = useState<DigitalEmployeeDraft>(() =>
    initialDraft.current,
  );
  const [tab, setTab] = useState<TabId>("profile");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const avatarInputRef = useRef<HTMLInputElement>(null);

  const update = (fields: Partial<DigitalEmployeeDraft>) =>
    setDraft((current) => ({ ...current, ...fields }));

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initialDraft.current),
    [draft],
  );

  /**
   * 遮罩 / Esc / 右上角关闭：有未保存修改时先确认。
   * 保存或删除成功走 onClose，不经过这里。
   */
  const requestClose = useCallback(async () => {
    if (!dirty) {
      onClose();
      return;
    }
    const confirmed = await confirmDialog({
      title: "放弃未保存的修改？",
      message: "数字员工的人设、提示词与能力绑定修改尚未保存。",
      confirmLabel: "放弃修改",
      tone: "danger",
    });
    if (confirmed) onClose();
  }, [dirty, onClose]);

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
      // 保存只落库；员工目录在下次运行前按最新定义物化
      if (employee) await ipc.updateEmployee(employee.id, payload);
      else await ipc.createEmployee(payload);
      await onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!employee) return;
    const confirmed = await confirmDialog({
      title: `删除数字员工「${employee.name}」？`,
      message: "此操作不可恢复。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) return;

    try {
      try {
        await ipc.deleteEmployee(employee.id);
      } catch (err) {
        const message = errorMessage(err);
        /*
         * 仍有聊天会话绑定该员工：主进程给出明确影响，
         * 用户确认后再带 force 重试。工作流引用不在这个分支，
         * 它会继续抛错并保持阻断。
         */
        if (!message.includes(EMPLOYEE_SESSION_IN_USE)) throw err;
        const proceed = await confirmDialog({
          title: "仍有会话在使用该员工",
          message,
          confirmLabel: "仍然删除",
          tone: "danger",
        });
        if (!proceed) return;
        await ipc.deleteEmployee(employee.id, true);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  // 员工本身不绑定 Agent，所有能力标签页始终可见；
  // 运行时是否支持由工作流节点选择的 Agent 决定。
  const visibleTabs = TABS;

  return (
    <Drawer
      onClose={onClose}
      requestClose={requestClose}
      ariaLabel={employee ? "编辑数字员工" : "新建数字员工"}
      width="md"
    >
      {/* 头部：当前员工身份 */}
      <DrawerHeader>
        <EmployeeAvatar employee={draft} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate ui-type-item font-semibold text-text">
              {draft.name.trim() || (employee ? "未命名员工" : "新建数字员工")}
            </span>
            {!draft.enabled && (
              <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 ui-type-note text-text-muted">
                已停用
              </span>
            )}
          </div>
          <div className="truncate ui-type-sub text-text-muted">
            {draft.role.trim() || "数字员工"}
          </div>
        </div>
        <DrawerCloseButton onClose={requestClose} />
      </DrawerHeader>

        {/* 标签栏 */}
        <div className="shrink-0 border-b border-border px-2 py-2">
          <SegmentedTabs
            value={tab}
            onChange={setTab}
            options={visibleTabs.map(({ id, label, icon: Icon }) => ({
              id,
              label,
              icon: <Icon className="h-3.5 w-3.5" />,
              count:
                id === "mcp"
                  ? draft.mcpServers.length
                  : id === "skills"
                    ? draft.skills.length
                    : id === "knowledge"
                      ? draft.knowledgeBases.length
                      : undefined,
            }))}
          />
        </div>

        {/* 标签内容 */}
        <DrawerBody>
          {tab === "profile" && (
            <ProfileTab
              draft={draft}
              update={update}
              onPickAvatar={() => avatarInputRef.current?.click()}
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
              onChange={(skills) => update({ skills })}
            />
          )}
          {tab === "knowledge" && (
            <KnowledgeTab
              bases={draft.knowledgeBases}
              onChange={(knowledgeBases) => update({ knowledgeBases })}
            />
          )}
        </DrawerBody>

        {/* 底部：删除 / 取消 / 保存 */}
        <DrawerFooter>
          <div className="flex min-w-0 items-center gap-1">
            {employee && (
              <Button
                size="sm"
                variant="dangerLink"
                onClick={handleDelete}
                icon={<Trash2 className="h-4 w-4" />}
              >
                删除员工
              </Button>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {error && (
              <span className="max-w-56 truncate ui-type-sub text-error" title={error}>
                {error}
              </span>
            )}
            <Button onClick={onClose}>取消</Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={!draft.name.trim()}
              loading={saving}
            >
              保存
            </Button>
          </div>
        </DrawerFooter>

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
    </Drawer>
  );
}

// ============================================================================
// 基本资料
// ============================================================================

function ProfileTab({
  draft,
  update,
  onPickAvatar,
}: {
  draft: DigitalEmployeeDraft;
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
            <Button
              variant="ghost"
              size="sm"
              icon={<Upload className="h-3.5 w-3.5" />}
              onClick={onPickAvatar}
            >
              上传头像
            </Button>
            {draft.avatar && (
              <button
                type="button"
                onClick={() => update({ avatar: null })}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 ui-type-note text-text-muted transition-colors hover:bg-surface-hover hover:text-error"
              >
                <Eraser className="h-3.5 w-3.5" />
                移除
              </button>
            )}
          </div>
          <p className="mt-1.5 ui-type-sub leading-relaxed text-text-muted">
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

      <Field
        label="系统提示词"
        hint="定义员工的身份、职责与行为边界，会作为每次执行的基础设定。"
      >
        <textarea
          value={draft.systemPrompt}
          onChange={(event) => update({ systemPrompt: event.target.value })}
          rows={12}
          placeholder={
            "例如：\n你是一名资深产品分析师。\n- 先澄清目标，再给出结论\n- 输出结构化、可执行的分析"
          }
          className={`${INPUT_CLASS} min-h-[240px] resize-y ui-type-code leading-relaxed`}
        />
      </Field>
      <div className="-mt-2 text-right ui-type-sub text-text-muted">
        {draft.systemPrompt.length} 字符
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
