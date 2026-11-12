/**
 * 设置操作（SQLite repository）
 *
 * 只包含该领域的 SQL 与行映射；连接与语句缓存见 ../connection。
 */

import { prepare } from "../connection";

// ============================================================================
// 设置操作
// ============================================================================

export function getSetting(key: string): string | null {
  const row = prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
  ).run(key, value, value);
}

