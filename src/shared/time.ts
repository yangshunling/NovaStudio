/**
 * 时间格式化基础工具（主进程与渲染进程共用）
 *
 * 只放「跨进程语义完全一致」的纯函数：补零、当天/本周起点、时分、日期时间与时长。
 * 带业务措辞的格式化（例如「今天 / 明天 / 周三 / 8月12日」）仍留在各业务模块，
 * 由这些基础函数组合而成，避免把文案差异硬塞进共享层。
 */

/** 一天的毫秒数 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 两位补零 */
export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 本地时区当天 0 点 */
export function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 本周一 0 点（周一为一周起点） */
export function startOfWeek(ts: number): number {
  const today = startOfDay(ts);
  const weekday = (new Date(today).getDay() + 6) % 7;
  return today - weekday * DAY_MS;
}

/** 两个时间戳是否落在同一个本地日期 */
export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** 周几的单字标签：日 / 一 / … / 六 */
export const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** 周几的完整短标签：周日 / 周一 */
export function weekdayShort(ts: number): string {
  return `周${WEEKDAY_LABELS[new Date(ts).getDay()]}`;
}

/** HH:mm */
export function formatHm(ts: number): string {
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** YYYY-MM-DD HH:mm:ss */
export function formatDateTime(ts: number | null): string {
  if (!ts) return "—";
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate(),
  )} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
    date.getSeconds(),
  )}`;
}

/** 0:34 / 2:46 / 1:02:03；未开始返回 — */
export function formatDuration(
  startedAt: number | null,
  finishedAt: number | null,
  now: number,
): string {
  if (!startedAt) return "—";
  const end = finishedAt ?? now;
  const total = Math.max(0, Math.floor((end - startedAt) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${minutes}:${pad2(seconds)}`;
}
