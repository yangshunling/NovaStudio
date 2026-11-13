/**
 * 工作区文件变动监听
 *
 * 监听集合由渲染层声明：根目录 + 当前展开的目录（相对路径，空串表示根）。
 * 只对这些目录各建一个非递归 watch，而不是递归监听整棵树 —— 递归监听
 * 无法在系统层排除 node_modules，装一次依赖就会产生数万次回调。
 *
 * 事件在主进程按项目合并：250ms 内同一目录的多次变化只上报一次，
 * 渲染层据此只重拉脏目录，展开状态与滚动位置都不受影响。
 *
 * 失败处理原则：拿不到目录、没有权限、inotify 到上限，一律静默跳过，
 * 由手动刷新兜底；不轮询、不重试。
 */

import { watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import { realpath } from "node:fs/promises";
import * as db from "../db/sqlite";
import { push } from "../ipc/push";
import { resolveInsideReal } from "../utils/paths";
import { isIgnoredName } from "./ignore";

/** 同一目录事件的合并窗口 */
const DEBOUNCE_MS = 250;

interface WatchedProject {
  /** 项目根目录的真实路径：watch / 越界校验都以它为准 */
  cwd: string;
  /** 相对目录 → watch 句柄 */
  watchers: Map<string, FSWatcher>;
  /** 本批次已变化、等待上报的目录 */
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
}

const projects = new Map<string, WatchedProject>();

/** 统一成 `/` 分隔、无首尾斜杠；根目录保持空串 */
function normalizeDir(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function closeProject(projectId: string): void {
  const state = projects.get(projectId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  for (const watcher of state.watchers.values()) watcher.close();
  projects.delete(projectId);
}

function scheduleFlush(projectId: string, state: WatchedProject): void {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    // 期间可能已经切换项目 / 关闭监听：旧状态不能再推给渲染层
    if (projects.get(projectId) !== state) return;
    const dirs = [...state.pending];
    state.pending.clear();
    if (dirs.length > 0) push("workspace:changed", { projectId, dirs });
  }, DEBOUNCE_MS);
  // 不阻止进程退出
  state.timer.unref?.();
}

function watchDir(
  projectId: string,
  state: WatchedProject,
  dir: string,
  absolutePath: string,
): FSWatcher | null {
  try {
    const watcher = watch(absolutePath, { persistent: false }, (_event, filename) => {
      // 忽略项的变化不反映在文件树上（依赖 / 构建目录 / 系统文件）
      if (filename && isIgnoredName(basename(String(filename)))) return;
      if (projects.get(projectId) !== state) return;
      state.pending.add(dir);
      scheduleFlush(projectId, state);
    });
    watcher.on("error", () => {
      // 目录被删除 / 权限变化：关掉这一个，父目录的事件会触发重新列目录
      watcher.close();
      if (state.watchers.get(dir) === watcher) state.watchers.delete(dir);
    });
    return watcher;
  } catch {
    return null;
  }
}

/**
 * 用新的目录集合替换某个项目的监听集合。
 * 传空数组等同于关闭该项目监听。
 */
export async function setWatchDirs(
  projectId: string,
  dirs: string[],
): Promise<void> {
  const wanted = new Set(dirs.map(normalizeDir));
  if (wanted.size === 0) {
    closeProject(projectId);
    return;
  }

  const project = db.getProject(projectId);
  if (!project?.cwd) {
    closeProject(projectId);
    return;
  }

  let cwd: string;
  try {
    cwd = await realpath(project.cwd);
  } catch {
    closeProject(projectId);
    return;
  }

  let state = projects.get(projectId);
  if (state && state.cwd !== cwd) {
    // 工作区换了位置：旧句柄全部作废
    closeProject(projectId);
    state = undefined;
  }
  if (!state) {
    state = { cwd, watchers: new Map(), pending: new Set(), timer: null };
    projects.set(projectId, state);
  }
  const current = state;

  // 收起 / 切换项目后不再需要的目录
  for (const [dir, watcher] of current.watchers) {
    if (wanted.has(dir)) continue;
    watcher.close();
    current.watchers.delete(dir);
  }

  for (const dir of wanted) {
    if (current.watchers.has(dir)) continue;
    // 渲染层传参不作数：必须真实存在于工作区内
    const absolutePath = await resolveInsideReal(cwd, dir);
    // 等待期间项目可能已被关闭 / 换过工作区，不能再往旧状态里塞句柄
    if (projects.get(projectId) !== current) return;
    // 并发的另一次调用可能刚建好同一个目录的监听
    if (current.watchers.has(dir)) continue;
    if (!absolutePath) continue;
    const watcher = watchDir(projectId, current, dir, absolutePath);
    if (watcher) current.watchers.set(dir, watcher);
  }
}

/** 关闭全部监听（应用退出 / 测试清理） */
export function closeAllWorkspaceWatchers(): void {
  for (const projectId of [...projects.keys()]) closeProject(projectId);
}
