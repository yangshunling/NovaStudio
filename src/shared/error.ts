/**
 * 错误信息转换（主进程与渲染进程共用）
 *
 * 统一「Error 取 message，其余值取 String()」的语义。
 * 渲染层的 `toMessage` 在此基础上追加 IPC 前缀剥离与兜底文案。
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "";
  }
}
