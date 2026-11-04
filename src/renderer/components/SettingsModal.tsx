/**
 * 设置弹框 — 基于通用 Modal 的模态框
 *
 * 皮肤切换已移到侧栏头部的昼夜切换按钮，这里只保留通用设置。
 */

import { useEffect, useRef, useState } from "react";
import { Info, SlidersHorizontal } from "lucide-react";
import logoUrl from "../assets/logo.png";
import { Modal, ModalHeader } from "./ui/Modal";
import { Select } from "./ui/Select";
import { useChatStore } from "../stores/chat";
import { useTheme } from "../hooks/useTheme";
import { ipc } from "../lib/ipc";
import { confirmDialog } from "../stores/confirm";
import {
  DEFAULT_SETTINGS,
  type AppInfo,
  type UpdaterState,
} from "@shared/types";

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
// 终端字号
// ============================================================================

/** 终端字号刻度比界面略宽：终端里常需要更大字号 */
const TERMINAL_FONT_SIZE_OPTIONS = [11, 12, 13, 14, 15, 16, 18, 20] as const;

function TerminalFontSizeControl() {
  const { terminalFontSize, setTerminalFontSize } = useTheme();

  return (
    <div className="mb-7">
      <h3 className="text-body font-semibold text-text">终端</h3>
      <p className="mt-1 mb-3 text-meta text-text-muted">
        终端字号独立于界面字号，修改后立即生效；字体固定使用系统等宽字体。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-20 shrink-0 text-meta text-text-muted">字号</span>
        {TERMINAL_FONT_SIZE_OPTIONS.map((size) => (
          <button
            key={size}
            onClick={() => setTerminalFontSize(size)}
            className={`rounded-md border px-3 py-1.5 text-meta transition-colors ${
              terminalFontSize === size
                ? "border-accent bg-accent-soft text-accent"
                : "border-border text-text-secondary hover:border-border-strong hover:text-text"
            }`}
          >
            {size}px
          </button>
        ))}
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
        className="ui-ring w-40 rounded-lg bg-input-bg px-inset py-inset text-body text-text"
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
    // 低于下限也夹到下限，与输入框提示“允许的区间”保持一致
    const next = Number.isFinite(n)
      ? Math.min(POLL_INTERVAL_MAX, Math.max(POLL_INTERVAL_MIN, n))
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
    const next = Number.isFinite(n)
      ? Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, n))
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
// 应用更新
// ============================================================================

/** 更新按钮的统一样式：次要操作 */
const UPDATE_BUTTON_CLASS =
  "rounded-md border border-border px-3 py-1.5 text-meta text-text-secondary transition-colors hover:border-border-strong hover:text-text";

/** 更新按钮的统一样式：主操作 */
const UPDATE_PRIMARY_BUTTON_CLASS =
  "rounded-md border border-accent bg-accent-soft px-3 py-1.5 text-meta text-accent transition-colors hover:bg-accent-soft/70";

function UpdateControl() {
  const [state, setState] = useState<UpdaterState | null>(null);

  useEffect(() => {
    void ipc
      .getUpdaterState()
      .then((next) => setState(next))
      .catch(() => {});
    // 主进程是唯一状态源：检查 / 下载 / 下载完成都通过推送同步
    return ipc.on.updaterChanged((next) => setState(next));
  }, []);

  const handleCheck = async () => {
    setState(await ipc.checkForUpdates());
  };

  const handleDownload = async () => {
    await ipc.downloadUpdate();
  };

  const handleInstall = async () => {
    const confirmed = await confirmDialog({
      title: "重启并安装更新？",
      message:
        "应用会立即关闭并安装新版本。正在运行的会话或工作流会被中断，请确认没有重要任务在执行。",
      confirmLabel: "重启并安装",
    });
    if (!confirmed) return;
    await ipc.installUpdate();
  };

  if (!state) {
    return (
      <div>
        <h3 className="text-body font-semibold text-text">应用更新</h3>
        <p className="mt-1 text-meta text-text-muted">正在读取更新状态…</p>
      </div>
    );
  }

  const { phase, version, percent, message, supported } = state;

  return (
    <div>
      <h3 className="text-body font-semibold text-text">应用更新</h3>
      <p className="mt-1 mb-3 text-meta text-text-muted">
        {supported
          ? "更新通过 GitHub Releases 分发，下载完成后可自行选择何时重启安装。"
          : "开发模式下不可用，打包安装后生效。"}
      </p>

      {phase === "checking" && (
        <p className="text-body text-text-secondary">正在检查更新…</p>
      )}
      {phase === "up-to-date" && (
        <p className="text-body text-text-secondary">已是最新版本。</p>
      )}
      {phase === "available" && (
        <p className="text-body text-text-secondary">
          发现新版本{" "}
          <span className="font-semibold text-text">v{version}</span>，可以立即下载。
        </p>
      )}
      {phase === "downloading" && (
        <div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-active">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 text-meta text-text-muted">
            正在下载更新… {percent}%
          </p>
        </div>
      )}
      {phase === "downloaded" && (
        <p className="text-body text-text-secondary">
          v{version} 已下载完成，重启应用即可完成安装。
        </p>
      )}
      {phase === "error" && (
        <p className="text-body text-error">{message ?? "检查更新失败。"}</p>
      )}
      {phase === "idle" && message && (
        <p className="text-meta text-text-muted">{message}</p>
      )}

      <div className="mt-3 flex items-center gap-2">
        {supported &&
          (phase === "idle" || phase === "up-to-date" || phase === "error") && (
            <button
              type="button"
              onClick={() => void handleCheck()}
              className={UPDATE_BUTTON_CLASS}
            >
              检查更新
            </button>
          )}
        {phase === "available" && (
          <button
            type="button"
            onClick={() => void handleDownload()}
            className={UPDATE_PRIMARY_BUTTON_CLASS}
          >
            下载更新
          </button>
        )}
        {phase === "downloaded" && (
          <button
            type="button"
            onClick={() => void handleInstall()}
            className={UPDATE_PRIMARY_BUTTON_CLASS}
          >
            重启并安装
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 关于
// ============================================================================

function platformLabel(platform: string): string {
  switch (platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return platform || "未知";
  }
}

/** 关于页里「名称 - 值」的一行 */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
      <span className="text-meta text-text-muted">{label}</span>
      <span className="select-text text-meta text-text-secondary">{value}</span>
    </div>
  );
}

function AboutPanel() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void ipc
      .getAppInfo()
      .then((next) => setInfo(next))
      .catch(() => {});
  }, []);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <h2 className="text-heading font-semibold text-text">关于</h2>
        <p className="mt-1 text-body text-text-muted">
          产品信息、运行环境与版本更新。
        </p>
      </div>

      {/* 品牌区 */}
      <div className="mb-6 flex items-center gap-4 rounded-xl border border-border bg-surface px-4 py-4">
        <img
          src={logoUrl}
          alt="Nova Studio"
          className="h-14 w-14 shrink-0 rounded-xl object-cover"
        />
        <div className="min-w-0">
          <p className="text-body-lg font-semibold text-text">Nova Studio</p>
          <p className="mt-0.5 text-meta text-text-muted">
            AI 智能体 CLI 的桌面 GUI 客户端
          </p>
        </div>
      </div>

      {/* 版本与运行环境 */}
      <div className="mb-8 rounded-xl border border-border px-4 py-1">
        <InfoRow label="版本" value={info ? `v${info.version}` : "—"} />
        <InfoRow label="Electron" value={info?.electron || "—"} />
        <InfoRow label="Chromium" value={info?.chrome || "—"} />
        <InfoRow label="Node.js" value={info?.node || "—"} />
        <InfoRow
          label="系统"
          value={info ? `${platformLabel(info.platform)} · ${info.arch}` : "—"}
        />
      </div>

      <UpdateControl />
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
      <TerminalFontSizeControl />
      <ConcurrencyControl />
      <PollIntervalControl />
      <TimeoutControl />
    </div>
  );
}

// ============================================================================
// 设置弹框主组件
// ============================================================================

type SettingsSection = "general" | "about";

/** 左侧菜单项：新增设置分组只需在这里加一行 */
const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  Icon: typeof SlidersHorizontal;
}> = [
  { id: "general", label: "通用", Icon: SlidersHorizontal },
  { id: "about", label: "关于", Icon: Info },
];

export function SettingsModal() {
  const setShowSettings = useChatStore((s) => s.setShowSettings);
  const [section, setSection] = useState<SettingsSection>("general");

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
    >
      {/* 弹框头 */}
      <ModalHeader
        title="设置"
        onClose={() => setShowSettings(false)}
        className="h-[var(--c-layout-header)] shrink-0 border-b border-border px-section"
      />

      {/* 弹框正文：左侧菜单 + 右侧内容 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧菜单 */}
        <aside className="flex w-[var(--c-layout-menu)] shrink-0 flex-col gap-1 border-r border-border p-2">
          {SETTINGS_SECTIONS.map(({ id, label, Icon }) => {
            const active = section === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={active ? "page" : undefined}
                className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2.5 text-body-lg font-medium transition-colors ${
                  active
                    ? "bg-surface-active text-text"
                    : "text-text-secondary hover:bg-surface-hover hover:text-text"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            );
          })}
        </aside>

        {/* 右侧内容区 */}
        <div className="flex-1 overflow-y-auto p-section">
          {section === "general" ? <GeneralPanel /> : <AboutPanel />}
        </div>
      </div>
    </Modal>
  );
}
