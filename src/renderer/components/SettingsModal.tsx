/**
 * 设置弹框 — 基于通用 Modal 的模态框
 *
 * 左侧菜单栏，右侧内容区。
 *
 * 皮肤列表、色卡、代码高亮主题全部由皮肤注册表驱动：
 * 色卡展示哪些 token 由皮肤自己的 preview 声明，本文件不出现任何具体皮肤 id。
 */

import { useEffect, useRef, useState } from "react";
import { Palette, Check, SlidersHorizontal } from "lucide-react";
import { Modal, ModalHeader } from "./ui/Modal";
import { useChatStore } from "../stores/chat";
import { useTheme } from "../hooks/useTheme";
import { ipc } from "../lib/ipc";
import { skins } from "../skins/registry";
import { DEFAULT_SETTINGS } from "@shared/types";
import type { SkinVariant } from "@shared/contracts/skin";

// ============================================================================
// 皮肤预览色卡
// ============================================================================

/** 色卡标签；未列出的 token 直接展示去掉 --c- 前缀的名字 */
const PREVIEW_LABELS: Record<string, string> = {
  "--c-bg": "背景",
  "--c-surface": "表面",
  "--c-surface-2": "次级表面",
  "--c-accent": "强调",
  "--c-text": "文字",
  "--c-border": "边框",
};

function SkinPreview({ skin }: { skin: SkinVariant }) {
  return (
    <div
      data-theme={skin.id}
      className="flex h-20 items-center gap-2 rounded-lg border border-border bg-surface-2 p-3"
    >
      {skin.preview.map((token) => (
        <div key={token} className="flex flex-1 flex-col items-center gap-1">
          <div
            className="h-8 w-full rounded-md border border-border"
            style={{ background: `var(${token})` }}
          />
          <span className="text-micro text-text-muted">
            {PREVIEW_LABELS[token] ?? token.replace(/^--c-/, "")}
          </span>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// 皮肤选择卡片
// ============================================================================

function SkinCard({
  skin,
  isActive,
  onSelect,
}: {
  skin: SkinVariant;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`group relative flex flex-col gap-3 rounded-xl border p-card text-left transition-all ${
        isActive
          ? "border-accent bg-accent-soft shadow-[var(--c-shadow-sm)]"
          : "border-border bg-surface-2/60 hover:border-border-strong hover:bg-surface-2/80"
      }`}
    >
      {isActive && (
        <div className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-caption font-medium text-accent-foreground">
          <Check className="h-3 w-3" />
          当前
        </div>
      )}

      <SkinPreview skin={skin} />

      <div>
        <h3 className={`text-title font-semibold ${isActive ? "text-accent" : "text-text"}`}>
          {skin.displayName}
        </h3>
        <p className="mt-1 text-meta leading-relaxed text-text-muted">{skin.description}</p>
      </div>
    </button>
  );
}

// ============================================================================
// 文字大小
// ============================================================================

const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16] as const;

/** 单行字号选项（全局 / 聊天记录共用同一套刻度） */
function FontSizeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (px: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-meta text-text-muted">{label}</span>
      {FONT_SIZE_OPTIONS.map((size) => (
        <button
          key={size}
          onClick={() => onChange(size)}
          className={`rounded-md border px-3 py-1.5 text-meta transition-colors ${
            value === size
              ? "border-accent bg-accent-soft text-accent"
              : "border-border text-text-secondary hover:border-border-strong hover:text-text"
          }`}
        >
          {size}px
        </button>
      ))}
    </div>
  );
}

function FontSizeControl() {
  const { fontSize, chatFontSize, setFontSize, setChatFontSize } = useTheme();

  return (
    <div className="mb-7">
      <h3 className="text-body font-semibold text-text">文字大小</h3>
      <p className="mt-1 mb-3 text-meta text-text-muted">
        全局字号是整套界面的缩放基准；聊天记录字号只作用于对话消息区，可单独调整而不影响其他界面。
      </p>
      <div className="space-y-3">
        <FontSizeRow label="全局" value={fontSize} onChange={setFontSize} />
        <FontSizeRow label="聊天记录" value={chatFontSize} onChange={setChatFontSize} />
      </div>
    </div>
  );
}

// ============================================================================
// 自动化并发数
// ============================================================================

/** 可选的并发上限：1 表示串行；最大值与主进程的硬上限保持一致 */
const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

function ConcurrencyControl() {
  const [value, setValue] = useState(DEFAULT_SETTINGS.automationConcurrency);

  // 真值在主进程设置里，挂载时同步一次
  useEffect(() => {
    void ipc.getSettings().then((s) => {
      if (s.automationConcurrency && s.automationConcurrency > 0) {
        setValue(s.automationConcurrency);
      }
    });
  }, []);

  const handleChange = (n: number) => {
    setValue(n);
    void ipc.setSettings({ automationConcurrency: n });
  };

  return (
    <div>
      <h3 className="text-body font-semibold text-text">自动化并发数</h3>
      <p className="mt-1 mb-3 text-meta text-text-muted">
        自动化看板同一时间最多执行的任务数，默认 {DEFAULT_SETTINGS.automationConcurrency}，修改后立即生效。
      </p>
      <select
        value={value}
        onChange={(e) => handleChange(Number(e.target.value))}
        className="ui-ring w-40 rounded-lg bg-input-bg px-inset py-inset text-body-lg text-text outline-none"
      >
        {CONCURRENCY_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n} 个
          </option>
        ))}
      </select>
    </div>
  );
}

// ============================================================================
// 看板扫描周期
// ============================================================================

/** 允许的扫描周期区间（秒）：下限 5 秒，上限 10 分钟 */
const POLL_INTERVAL_MIN = 5;
const POLL_INTERVAL_MAX = 600;

function PollIntervalControl() {
  const [draft, setDraft] = useState(String(DEFAULT_SETTINGS.automationPollIntervalSec));
  /** 最近一次已保存的值：输入非法时回退到它，而不是回退默认值 */
  const saved = useRef(DEFAULT_SETTINGS.automationPollIntervalSec);

  // 真值在主进程设置里，挂载时同步一次
  useEffect(() => {
    void ipc.getSettings().then((s) => {
      const sec = s.automationPollIntervalSec;
      if (sec && sec > 0) {
        saved.current = sec;
        setDraft(String(sec));
      }
    });
  }, []);

  /** 失焦 / 回车时提交：非法值回退到上次保存值，合法值夹到区间内 */
  const commit = () => {
    const n = Math.floor(Number(draft));
    const next =
      Number.isFinite(n) && n >= POLL_INTERVAL_MIN
        ? Math.min(n, POLL_INTERVAL_MAX)
        : saved.current;
    saved.current = next;
    setDraft(String(next));
    void ipc.setSettings({ automationPollIntervalSec: next });
  };

  return (
    <div className="mt-7">
      <h3 className="text-body font-semibold text-text">看板扫描周期</h3>
      <p className="mt-1 mb-3 text-meta text-text-muted">
        自动化看板扫描待执行任务的间隔时间（秒），默认{" "}
        {DEFAULT_SETTINGS.automationPollIntervalSec} 秒，修改后下一周期即生效。间隔过短会增加性能开销。
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={POLL_INTERVAL_MIN}
          max={POLL_INTERVAL_MAX}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="ui-ring w-32 rounded-lg bg-input-bg px-inset py-inset text-body-lg text-text outline-none"
        />
        <span className="text-body text-text-muted">秒</span>
      </div>
    </div>
  );
}

// ============================================================================
// 单次运行超时
// ============================================================================

/** 允许的超时区间（分钟）：下限 1 分钟，上限 24 小时 */
const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 1440;

function TimeoutControl() {
  const [draft, setDraft] = useState(String(DEFAULT_SETTINGS.agentTimeoutMinutes));
  /** 最近一次已保存的值：输入非法时回退到它，而不是回退默认值 */
  const saved = useRef(DEFAULT_SETTINGS.agentTimeoutMinutes);

  // 真值在主进程设置里，挂载时同步一次
  useEffect(() => {
    void ipc.getSettings().then((s) => {
      const minutes = s.agentTimeoutMinutes;
      if (minutes && minutes > 0) {
        saved.current = minutes;
        setDraft(String(minutes));
      }
    });
  }, []);

  /** 失焦 / 回车时提交：非法值回退到上次保存值，合法值夹到区间内 */
  const commit = () => {
    const n = Math.floor(Number(draft));
    const next =
      Number.isFinite(n) && n >= TIMEOUT_MIN
        ? Math.min(n, TIMEOUT_MAX)
        : saved.current;
    saved.current = next;
    setDraft(String(next));
    void ipc.setSettings({ agentTimeoutMinutes: next });
  };

  return (
    <div className="mt-7">
      <h3 className="text-body font-semibold text-text">单次运行超时</h3>
      <p className="mt-1 mb-3 text-meta text-text-muted">
        Agent 单次执行的最长时间（分钟），超过后会被中断并记为失败，默认{" "}
        {DEFAULT_SETTINGS.agentTimeoutMinutes} 分钟。
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={TIMEOUT_MIN}
          max={TIMEOUT_MAX}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="ui-ring w-32 rounded-lg bg-input-bg px-inset py-inset text-body-lg text-text outline-none"
        />
        <span className="text-body text-text-muted">分钟</span>
      </div>
    </div>
  );
}

// ============================================================================
// 换肤面板
// ============================================================================

function ThemePanel() {
  const { currentTheme, setTheme } = useTheme();

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <h2 className="text-heading font-semibold text-text">皮肤选择</h2>
        <p className="mt-1 text-body text-text-muted">选择你喜欢的皮肤风格，切换即时生效。</p>
      </div>

      <div className="mb-7 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {skins.map((skin) => (
          <SkinCard
            key={skin.id}
            skin={skin}
            isActive={currentTheme === skin.id}
            onSelect={() => setTheme(skin.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// 通用面板
// ============================================================================

function GeneralPanel() {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <h2 className="text-heading font-semibold text-text">通用</h2>
        <p className="mt-1 text-body text-text-muted">界面、自动化等通用设置，修改后立即生效。</p>
      </div>

      <FontSizeControl />
      <ConcurrencyControl />
      <PollIntervalControl />
      <TimeoutControl />
    </div>
  );
}

// ============================================================================
// 设置弹框主组件
// ============================================================================

type SettingsSection = "general" | "theme";

const menuItems: Array<{ id: SettingsSection; label: string; icon: React.ReactNode }> = [
  { id: "general", label: "通用", icon: <SlidersHorizontal className="h-4 w-4" /> },
  { id: "theme", label: "换肤", icon: <Palette className="h-4 w-4" /> },
];

export function SettingsModal() {
  const [section, setSection] = useState<SettingsSection>("general");
  const setShowSettings = useChatStore((s) => s.setShowSettings);

  return (
    // 由 App.tsx 的 showSettings 条件渲染控制挂载，因此此处 open 恒为 true
    <Modal
      open={true}
      onClose={() => setShowSettings(false)}
      size={{
        width: "var(--c-layout-modal-w)",
        height: "var(--c-layout-modal-h)",
        maxWidth: "1200px",
        maxHeight: "800px",
      }}
      className="ui-glass-strong flex flex-col overflow-hidden rounded-2xl"
    >
      {/* 弹框头 */}
      <ModalHeader
        title="设置"
        onClose={() => setShowSettings(false)}
        className="h-[var(--c-layout-header)] shrink-0 border-b border-border px-5"
      />

      {/* 弹框正文：左菜单 + 右内容 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧菜单 */}
        <aside className="flex w-[var(--c-layout-menu)] shrink-0 flex-col border-r border-border p-2">
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-body font-medium transition-colors ${
                section === item.id
                  ? "bg-surface-active text-text"
                  : "text-text-muted hover:bg-surface-hover hover:text-text"
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </aside>

        {/* 右侧内容区 */}
        <div className="flex-1 overflow-y-auto p-section">
          {section === "general" && <GeneralPanel />}
          {section === "theme" && <ThemePanel />}
        </div>
      </div>
    </Modal>
  );
}
