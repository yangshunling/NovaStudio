/**
 * MCP 纯函数工具
 *
 * 这些函数不依赖文件系统，主进程与渲染进程共用同一套解析/格式化规则，
 * 避免「UI 预览」和「运行时注入」对同一份 args/env 得出不同结果。
 */

/** 参数拆分：支持单双引号，其余按空白切分 */
export function splitArgs(raw: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    result.push(match[1] ?? match[2] ?? match[3]);
  }
  return result;
}

/** 每行 KEY=VALUE；忽略空行与 # 注释 */
export function parseKeyValueLines(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1);
  }
  return result;
}

/** Record → 每行 KEY=VALUE */
export function formatKeyValue(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
