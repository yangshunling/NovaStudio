/**
 * 文件系统小工具
 */

/** cp 过滤：不复制 VCS 元数据与系统垃圾文件 */
export function copyFilter(source: string): boolean {
  const name = source.split(/[\\/]/).pop() ?? source;
  return name !== ".git" && name !== ".DS_Store";
}
