/**
 * 设置弹框 — 基于通用 Modal 的模态框
 *
 * 皮肤切换已移到侧栏头部的昼夜切换按钮，这里只保留通用设置。
 */

import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Modal, ModalHeader } from "./ui/Modal";
import { Select } from "./ui/Select";
import { useChatStore } from "../stores/chat";
import { useTheme } from "../hooks/useTheme";
import { ipc } from "../lib/ipc";
import { DEFAULT_SETTINGS } from "@shared/types";

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
        全局字号是整套界面的缩放基准；聊天记录可单独调整，文件预览与工作区文件跟随全局字号。
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
      <Select
        value={String(value)}
        onChange={(next) => handleChange(Number(next))}
        className="ui-ring w-40 rounded-lg bg-input-bg px-inset py-inset text-body-lg text-text"
        minMenuWidth={160}
        options={CONCURRENCY_OPTIONS.map((n) => ({
          value: String(n),
          label: `${n} 个`,
        }))}
      />
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

export function SettingsModal() {
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

      {/* 弹框正文：左侧菜单 + 右侧内容 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧菜单 */}
        <aside className="flex w-[var(--c-layout-menu)] shrink-0 flex-col border-r border-border p-2">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md bg-surface-active px-3 py-2.5 text-body font-medium text-text"
          >
            <SlidersHorizontal className="h-4 w-4" />
            通用
          </button>
        </aside>

        {/* 右侧内容区 */}
        <div className="flex-1 overflow-y-auto p-section">
          <GeneralPanel />
        </div>
      </div>
    </Modal>
  );
}
