/**
 * JSON 安全解析与 unknown 收窄（主进程与渲染进程共用）
 *
 * 只放纯函数；读文件、写文件仍留在各自进程，避免渲染层引入 node:fs。
 */

/** 解析 JSON；语法错误或空输入时返回 fallback */
export function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 解析 JSON 数组；不是数组或解析失败时返回空数组 */
export function parseJsonArray<T>(raw: string): T[] {
  const value = parseJsonSafe<unknown>(raw, null);
  return Array.isArray(value) ? (value as T[]) : [];
}

/** 安全取字符串字段 */
export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 安全取字符串数组（元素统一 String()） */
export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** 安全取 string → string 记录；非字符串值忽略 */
export function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}
