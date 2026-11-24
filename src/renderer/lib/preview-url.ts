/**
 * 工作区文件的预览地址
 *
 * `nova-preview://file/<文件名>?project=<id>&path=<相对路径>` 由主进程按需
 * 流式返回（支持 Range）。文件名前缀只用于让 Chromium 推断 MIME 与
 * 扩展名，真正决定读哪个文件的是 project + path。
 */
export function previewUrl(projectId: string, relativePath: string): string {
  const name = relativePath.split(/[\\/]/).pop() || "file";
  const params = new URLSearchParams({ project: projectId, path: relativePath });
  return `nova-preview://file/${encodeURIComponent(name)}?${params.toString()}`;
}
