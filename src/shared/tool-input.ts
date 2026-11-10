/**
 * 工具调用输入的字段约定（主进程与渲染进程共用）
 *
 * 不同 Agent 的工具参数命名不一致（path / file / file_path…），
 * 展示层与解析层必须按同一优先级取字段，否则会出现「主进程认路径、
 * 渲染层认不到」的漂移。
 */

/** 操作对象候选字段，按优先级排列 */
export const TOOL_TARGET_KEYS = [
  "path",
  "file",
  "filePath",
  "file_path",
  "command",
  "pattern",
  "query",
] as const;

/** 按候选字段顺序取第一个非空字符串；取不到返回空串 */
export function readStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}
