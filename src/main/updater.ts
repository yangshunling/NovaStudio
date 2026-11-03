/**
 * 应用内自动更新（GitHub Releases）
 *
 * 设计要点：
 * - **主进程是唯一状态源**。electron-updater 的事件在这里归一成 `UpdaterState`，
 *   渲染进程只订阅 `updater:changed` 并触发 check / download / install 三个动作。
 * - **更新地址不写死**。electron-builder 打包时会把 `publish` 配置写成
 *   `resources/app-update.yml`，运行时由 electron-updater 自动读取。
 * - **不自动下载**。`autoDownload=false`，由用户显式点击下载，避免启动时
 *   偷偷占用带宽；下载完成后也不强制重启，由用户决定何时安装。
 * - **开发模式直接禁用**。未打包时没有 app-update.yml，electron-updater 会报错。
 */

import { app } from "electron";
import type { UpdaterState } from "../shared/types";
import { push } from "./ipc/push";

/**
 * electron-updater 是 CommonJS 包，`autoUpdater` 通过 Object.defineProperty
 * 的 getter 导出，Node 的 ESM 具名导出探测识别不到它。
 *
 * 若写成 `import { autoUpdater } from "electron-updater"`，构建不会报错，
 * 但打包后运行时会抛 "does not provide an export named 'autoUpdater'"。
 * 因此这里用默认导入（= module.exports）再解构，运行时才可靠。
 */
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let state: UpdaterState = {
  phase: "idle",
  currentVersion: app.getVersion(),
  version: null,
  percent: 0,
  message: null,
  supported: app.isPackaged,
};

function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch };
  push("updater:changed", state);
}

/** 供 IPC 读取当前快照（页面首次挂载时用） */
export function getUpdaterState(): UpdaterState {
  return state;
}

/**
 * 主动检查更新。
 *
 * 启动时静默调用一次；用户点「检查更新」也走这里。
 * 网络失败只落到 error 状态，不抛给调用方，避免 IPC 层报错。
 */
export async function checkForUpdates(): Promise<UpdaterState> {
  if (!app.isPackaged) {
    setState({
      phase: "idle",
      supported: false,
      message: "开发模式下不检查更新，打包安装后生效。",
    });
    return state;
  }

  setState({ phase: "checking", message: null, percent: 0 });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setState({ phase: "error", message: toMessage(err) });
  }
  return state;
}

/** 开始下载已发现的版本；返回 false 表示当前阶段不允许下载 */
export function downloadUpdate(): boolean {
  if (!app.isPackaged || state.phase !== "available") return false;

  setState({ phase: "downloading", percent: 0, message: null });
  void autoUpdater.downloadUpdate().catch((err) => {
    setState({ phase: "error", message: toMessage(err) });
  });
  return true;
}

/**
 * 重启并安装已下载的版本。
 *
 * 用 setImmediate 延后执行：先让本次 IPC 应答回到渲染进程，
 * 再触发 quitAndInstall，避免应答尚未送达进程就被关闭。
 */
export function installUpdate(): boolean {
  if (!app.isPackaged || state.phase !== "downloaded") return false;
  setImmediate(() => autoUpdater.quitAndInstall());
  return true;
}

let initialized = false;

/** 挂载 electron-updater 事件并触发一次启动检查；重复调用无副作用 */
export function initUpdater(): void {
  if (initialized) return;
  initialized = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // 不允许降级：避免把用户从更新通道拉回旧版本
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("checking-for-update", () => {
    setState({ phase: "checking", message: null, percent: 0 });
  });

  autoUpdater.on("update-available", (info) => {
    setState({
      phase: "available",
      version: info.version,
      message: null,
      percent: 0,
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    setState({
      phase: "up-to-date",
      version: info.version,
      message: null,
      percent: 0,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setState({
      phase: "downloading",
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setState({
      phase: "downloaded",
      version: info.version,
      percent: 100,
      message: null,
    });
  });

  autoUpdater.on("error", (err) => {
    setState({ phase: "error", message: toMessage(err) });
  });

  if (!app.isPackaged) {
    setState({
      supported: false,
      message: "开发模式下不检查更新，打包安装后生效。",
    });
    return;
  }

  // 启动后稍作延迟再检查，避免和窗口首屏、资产扫描抢网络
  setTimeout(() => {
    void checkForUpdates();
  }, 3000);
}
