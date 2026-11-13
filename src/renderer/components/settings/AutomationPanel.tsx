/**
 * 自动化设置：看板的任务调度参数
 *
 * 三个参数都作用于无人值守运行，修改后由主进程下一周期读取生效。
 */

import { useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS } from "@shared/types";
import { clamp } from "@shared/math";
import { useAppSettingsStore } from "../../hooks/useAppSettings";
import { Select } from "../ui/Select";
import {
  SettingsCard,
  SettingsPage,
  SettingsRow,
} from "./SettingsLayout";

/** 可选的并发上限：1 表示串行；最大值与主进程的硬上限保持一致 */
const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** 允许的扫描周期区间（秒）：下限 5 秒，上限 10 分钟 */
const POLL_INTERVAL_MIN = 5;
const POLL_INTERVAL_MAX = 600;

/** 允许的超时区间（分钟）：下限 1 分钟，上限 24 小时 */
const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 1440;

/**
 * 右侧控件统一样式。
 *
 * 三个参数的控件必须同宽、右边缘对齐：单位写在描边容器内部，
 * 而不是挂在输入框外面 —— 否则「秒 / 分钟」会把输入框整体往左挤。
 */
const CONTROL_CLASS =
  "ui-ring w-32 rounded-lg bg-input-bg px-inset py-inset ui-type-note text-text transition-colors focus-within:border-input-border-focus focus:border-input-border-focus";

/**
 * 数值型设置行内控件。
 *
 * 失焦 / 回车时提交：非法值回退到上次保存值，合法值夹到区间内，
 * 避免输入过程中每敲一个字符就写一次设置。
 */
function NumberSetting({
  value,
  min,
  max,
  unit,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  unit: string;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  /** 最近一次已保存的值：输入非法时回退到它，而不是回退默认值 */
  const saved = useRef(value);

  // 设置从主进程读回后同步到输入框
  useEffect(() => {
    saved.current = value;
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const n = Math.floor(Number(draft));
    const next = Number.isFinite(n) ? clamp(n, min, max) : saved.current;
    saved.current = next;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <div className={`flex items-center gap-1.5 ${CONTROL_CLASS}`}>
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="min-w-0 flex-1 bg-transparent text-text outline-none"
      />
      <span className="shrink-0 text-text-muted">{unit}</span>
    </div>
  );
}

export function AutomationPanel() {
  const automationConcurrency = useAppSettingsStore(
    (s) => s.automationConcurrency,
  );
  const automationPollIntervalSec = useAppSettingsStore(
    (s) => s.automationPollIntervalSec,
  );
  const agentTimeoutMinutes = useAppSettingsStore((s) => s.agentTimeoutMinutes);
  const update = useAppSettingsStore((s) => s.update);

  return (
    <SettingsPage
      title="自动化"
      description="自动化看板的任务执行与调度参数，修改后立即生效。"
    >
      <SettingsCard title="调度">
        <SettingsRow
          label="并发数"
          hint={`同时执行的任务数上限，默认 ${DEFAULT_SETTINGS.automationConcurrency}。`}
        >
          <Select
            value={String(automationConcurrency)}
            onChange={(next) =>
              void update({ automationConcurrency: Number(next) })
            }
            className={CONTROL_CLASS}
            minMenuWidth={120}
            options={CONCURRENCY_OPTIONS.map((n) => ({
              value: String(n),
              label: `${n} 个`,
            }))}
          />
        </SettingsRow>

        <SettingsRow
          label="看板扫描周期"
          hint={`默认 ${DEFAULT_SETTINGS.automationPollIntervalSec} 秒；间隔过短会增加性能开销。`}
        >
          <NumberSetting
            value={automationPollIntervalSec}
            min={POLL_INTERVAL_MIN}
            max={POLL_INTERVAL_MAX}
            unit="秒"
            onCommit={(next) => void update({ automationPollIntervalSec: next })}
          />
        </SettingsRow>

        <SettingsRow
          label="单次运行超时"
          hint={`默认 ${DEFAULT_SETTINGS.agentTimeoutMinutes} 分钟；超过后中断并记为失败。`}
        >
          <NumberSetting
            value={agentTimeoutMinutes}
            min={TIMEOUT_MIN}
            max={TIMEOUT_MAX}
            unit="分钟"
            onCommit={(next) => void update({ agentTimeoutMinutes: next })}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsPage>
  );
}
