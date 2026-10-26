/**
 * 触发器定时规则（主进程与渲染进程共用）
 *
 * 只做三件事：清洗外部输入、算出下一次触发时刻、生成给人看的摘要。
 * 时间统一按本机时区解释 —— 用户配置「每天 09:00」，就是本机的 09:00。
 */

import type { WorkflowTriggerSchedule } from "./types";

/** 星期展示顺序：周一在前，符合中文习惯 */
export const TRIGGER_WEEKDAYS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 0, label: "周日" },
];

/** 间隔触发的上下限（分钟）：下限避免把应用打成死循环，上限一天的分钟数 */
export const TRIGGER_INTERVAL_MIN = 1;
export const TRIGGER_INTERVAL_MAX = 1440;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAY_ORDER = TRIGGER_WEEKDAYS.map((item) => item.value);
const MINUTE_MS = 60_000;

/** 是否是合法的 HH:mm */
export function isValidTriggerTime(value: unknown): value is string {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

/** 按周一 → 周日的顺序排序每周选项 */
export function sortWeekdays(days: number[]): number[] {
  return [...new Set(days)].sort(
    (a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b),
  );
}

/**
 * 清洗任意来源的定时规则。
 * 损坏 / 缺字段时回退到「每天 09:00」，而不是抛错阻断列表展示。
 */
export function normalizeTriggerSchedule(raw: unknown): WorkflowTriggerSchedule {
  const value = (raw ?? {}) as Record<string, unknown>;

  if (value.kind === "weekly") {
    const time = isValidTriggerTime(value.time) ? value.time : "09:00";
    const days = Array.isArray(value.weekdays)
      ? value.weekdays.filter(
          (day): day is number =>
            typeof day === "number" &&
            Number.isInteger(day) &&
            day >= 0 &&
            day <= 6,
        )
      : [];
    return {
      kind: "weekly",
      time,
      weekdays: days.length > 0 ? sortWeekdays(days) : [1, 2, 3, 4, 5],
    };
  }

  if (value.kind === "interval") {
    const rawMinutes = Number(value.minutes);
    const minutes = Number.isFinite(rawMinutes)
      ? Math.min(
          TRIGGER_INTERVAL_MAX,
          Math.max(TRIGGER_INTERVAL_MIN, Math.round(rawMinutes)),
        )
      : 60;
    return { kind: "interval", minutes };
  }

  return {
    kind: "daily",
    time: isValidTriggerTime(value.time) ? value.time : "09:00",
  };
}

/** 下一次触发时刻（毫秒时间戳），严格晚于 from */
export function nextTriggerFireAt(
  schedule: WorkflowTriggerSchedule,
  from: number = Date.now(),
): number {
  if (schedule.kind === "interval") {
    return from + schedule.minutes * MINUTE_MS;
  }

  const [hour, minute] = schedule.time.split(":").map(Number);

  if (schedule.kind === "daily") {
    const today = new Date(from);
    today.setHours(hour, minute, 0, 0);
    if (today.getTime() > from) return today.getTime();

    const tomorrow = new Date(from);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(hour, minute, 0, 0);
    return tomorrow.getTime();
  }

  const weekdays =
    schedule.weekdays.length > 0 ? schedule.weekdays : [1, 2, 3, 4, 5];
  // 最多看 8 天：保证无论今天是否命中，都能找到下一周的同一天
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (weekdays.includes(candidate.getDay()) && candidate.getTime() > from) {
      return candidate.getTime();
    }
  }

  // 理论上不可达：一周内必然至少有一个匹配日
  return from + 7 * 24 * 60 * MINUTE_MS;
}

/** 生成规则摘要，例如「每天 09:00」「每周（周一、周三）18:30」「每隔 30 分钟」 */
export function describeTriggerSchedule(
  schedule: WorkflowTriggerSchedule,
): string {
  if (schedule.kind === "interval") {
    if (schedule.minutes % 60 === 0) {
      return `每隔 ${schedule.minutes / 60} 小时`;
    }
    return `每隔 ${schedule.minutes} 分钟`;
  }

  if (schedule.kind === "daily") {
    return `每天 ${schedule.time}`;
  }

  const labels = sortWeekdays(schedule.weekdays)
    .map(
      (day) =>
        TRIGGER_WEEKDAYS.find((item) => item.value === day)?.label ?? "周一",
    )
    .join("、");
  return `每周（${labels}）${schedule.time}`;
}
