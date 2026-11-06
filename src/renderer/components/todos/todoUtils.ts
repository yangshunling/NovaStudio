/**
 * 待办页的纯函数：日期分桶 / 排序 / 标签汇总 / 日期输入转换。
 *
 * 与 DOM、React 无关，页面只负责组合。日期粒度到「天」，
 * 所有比较都基于本地时区的当天 0 点，避免时区换算带来的跨天误差。
 */

import type { TodoItem, TodoPriority } from "@shared/types";

export type TodoFilter = "all" | "pending" | "done";
export type TodoSort = "manual" | "due" | "priority" | "created";
export type DueBucket = "overdue" | "today" | "week" | "later" | "none";

const DAY = 24 * 60 * 60 * 1000;

export const DUE_BUCKET_ORDER: DueBucket[] = [
  "overdue",
  "today",
  "week",
  "later",
  "none",
];

export const DUE_BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: "已逾期",
  today: "今天",
  week: "本周",
  later: "以后",
  none: "无日期",
};

export const PRIORITY_LABEL: Record<TodoPriority, string> = {
  high: "高",
  normal: "普通",
  low: "低",
};

const PRIORITY_ORDER: Record<TodoPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

export const PRIORITY_OPTIONS: { id: TodoPriority; label: string }[] = [
  { id: "high", label: "高" },
  { id: "normal", label: "普通" },
  { id: "low", label: "低" },
];

export const SORT_OPTIONS: { value: TodoSort; label: string }[] = [
  { value: "manual", label: "自定义顺序" },
  { value: "due", label: "按截止时间" },
  { value: "priority", label: "按优先级" },
  { value: "created", label: "按创建时间" },
];

/** 本地时区当天 0 点 */
export function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 本周开始 = 本周一 0 点（周一为一周起点） */
export function startOfWeek(ts: number): number {
  const today = startOfDay(ts);
  const weekday = (new Date(today).getDay() + 6) % 7; // 周一 = 0
  return today - weekday * DAY;
}

/** 本周结束 = 下一个周一 0 点 */
function endOfWeek(now: number): number {
  return startOfWeek(now) + 7 * DAY;
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** 周几的单字标签：周一 / 周日 */
export function weekdayShort(ts: number): string {
  return `周${"日一二三四五六"[new Date(ts).getDay()]}`;
}

/**
 * 连续处理天数。
 * 今天还没有完成时从昨天开始算，避免白天就显示为断档。
 */
export function completionStreak(todos: TodoItem[], now = Date.now()): number {
  const days = new Set(
    todos
      .filter((item) => item.done && item.completedAt !== null)
      .map((item) => startOfDay(item.completedAt!)),
  );
  let cursor = startOfDay(now);
  if (!days.has(cursor)) cursor -= DAY;
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor -= DAY;
  }
  return streak;
}

export interface CompletionDay {
  ts: number;
  /** 周几单字，用于柱状图标签 */
  label: string;
  count: number;
  isToday: boolean;
}

/** 最近 N 天（含今天）的完成数量，按时间正序返回 */
export function completionSeries(
  todos: TodoItem[],
  days = 7,
  now = Date.now(),
): CompletionDay[] {
  const today = startOfDay(now);
  const counts = new Map<number, number>();
  for (const item of todos) {
    if (!item.done || item.completedAt === null) continue;
    const key = startOfDay(item.completedAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from({ length: days }, (_, index) => {
    const ts = today - (days - 1 - index) * DAY;
    return {
      ts,
      label: "日一二三四五六"[new Date(ts).getDay()],
      count: counts.get(ts) ?? 0,
      isToday: ts === today,
    };
  });
}

export function dueBucket(dueAt: number | null, now = Date.now()): DueBucket {
  if (dueAt === null) return "none";
  const today = startOfDay(now);
  if (dueAt < today) return "overdue";
  if (dueAt < today + DAY) return "today";
  if (dueAt < endOfWeek(now)) return "week";
  return "later";
}

export function isOverdue(item: TodoItem, now = Date.now()): boolean {
  return !item.done && item.dueAt !== null && item.dueAt < startOfDay(now);
}

/** 行内截止日期文案：今天 / 明天 / 昨天 / 周四 / 8月12日 / 2027年1月3日 */
export function formatDueLabel(dueAt: number, now = Date.now()): string {
  const today = startOfDay(now);
  const diffDays = Math.round((startOfDay(dueAt) - today) / DAY);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "明天";
  if (diffDays === -1) return "昨天";

  const date = new Date(dueAt);
  if (dueAt >= today && dueAt < endOfWeek(now)) {
    return `周${"日一二三四五六"[date.getDay()]}`;
  }
  const prefix =
    date.getFullYear() === new Date(now).getFullYear()
      ? ""
      : `${date.getFullYear()}年`;
  return `${prefix}${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 纯日期文案：8月12日 / 2027年1月3日（不带「今天 / 明天」语义） */
export function formatDateLabel(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const prefix =
    date.getFullYear() === new Date(now).getFullYear()
      ? ""
      : `${date.getFullYear()}年`;
  return `${prefix}${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 完成时间文案：今天 14:20 / 8月12日 */
export function formatCompletedAt(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
  if (startOfDay(ts) === startOfDay(now)) return `今天 ${time}`;
  return formatDueLabel(ts, now);
}

function compareManual(a: TodoItem, b: TodoItem): number {
  return a.sortOrder - b.sortOrder || b.createdAt - a.createdAt;
}

function comparePriority(a: TodoItem, b: TodoItem): number {
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
}

function compareDue(a: TodoItem, b: TodoItem): number {
  if (a.dueAt === null && b.dueAt === null) return 0;
  if (a.dueAt === null) return 1;
  if (b.dueAt === null) return -1;
  return a.dueAt - b.dueAt;
}

export function sortTodos(items: TodoItem[], sort: TodoSort): TodoItem[] {
  const list = [...items];
  switch (sort) {
    case "created":
      return list.sort((a, b) => b.createdAt - a.createdAt);
    case "due":
      return list.sort(
        (a, b) =>
          compareDue(a, b) ||
          comparePriority(a, b) ||
          compareManual(a, b),
      );
    case "priority":
      return list.sort(
        (a, b) =>
          comparePriority(a, b) ||
          compareDue(a, b) ||
          compareManual(a, b),
      );
    default:
      return list.sort(compareManual);
  }
}

export interface TodoGroup {
  bucket: DueBucket;
  label: string;
  items: TodoItem[];
}

/** 按截止时间分组；空分组不返回，顺序固定为「逾期 → 今天 → 本周 → 以后 → 无日期」 */
export function groupTodos(items: TodoItem[], now = Date.now()): TodoGroup[] {
  const buckets = new Map<DueBucket, TodoItem[]>();
  for (const item of items) {
    const bucket = dueBucket(item.dueAt, now);
    const list = buckets.get(bucket);
    if (list) list.push(item);
    else buckets.set(bucket, [item]);
  }
  return DUE_BUCKET_ORDER.filter((bucket) => buckets.has(bucket)).map(
    (bucket) => ({
      bucket,
      label: DUE_BUCKET_LABEL[bucket],
      items: buckets.get(bucket)!,
    }),
  );
}

/** 汇总全部标签，按使用频次倒序；频次相同按拼音排序，保证顺序稳定 */
export function collectTags(items: TodoItem[]): string[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const item of items) {
    for (const tag of item.tags) {
      const key = tag.toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { label: tag, count: 1 });
    }
  }
  return [...counts.values()]
    .sort(
      (a, b) =>
        b.count - a.count || a.label.localeCompare(b.label, "zh-CN"),
    )
    .map((entry) => entry.label);
}

/** 时间戳 → <input type="date"> 的 yyyy-MM-dd */
export function toDateInputValue(ts: number | null): string {
  if (ts === null) return "";
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}`;
}

/** <input type="date"> 的值 → 当天 0 点时间戳 */
export function fromDateInputValue(value: string): number | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}
