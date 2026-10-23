/**
 * 工作流运行相关的通用格式化
 */

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 2026-10-23 10:16:02 */
export function formatDateTime(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
