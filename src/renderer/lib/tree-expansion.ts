/**
 * 文件树展开状态（按工作区）
 *
 * 展开状态原本只存在组件 state 里，渲染进程一旦重载（开发模式的 Vite
 * 热更新 / Fast Refresh、切换视图导致的重新挂载）就会全部折叠。
 * 这里用 sessionStorage 记住每个工作区展开过的目录：
 *   - 页面重载：恢复
 *   - 应用退出：随会话清空（不跨启动累积）
 *
 * 只存相对路径；路径已不存在的目录在恢复后自然不出现在树里。
 */

const KEY_PREFIX = "nova:tree-expanded:";

function storageKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

export function readExpandedPaths(projectId: string): Set<string> {
  if (!projectId) return new Set();
  try {
    const raw = sessionStorage.getItem(storageKey(projectId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

export function writeExpandedPaths(
  projectId: string,
  paths: Set<string>,
): void {
  if (!projectId) return;
  try {
    sessionStorage.setItem(storageKey(projectId), JSON.stringify([...paths]));
  } catch {
    // 存储不可用（隐私模式 / 配额）：只影响重载后的恢复，不影响当前交互
  }
}
