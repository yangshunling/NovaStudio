/**
 * Nova — 主进程入口
 *
 * 职责：
 * 1. 创建 BrowserWindow
 * 2. 初始化数据库
 * 3. 注册 IPC 处理器
 * 4. 加载渲染进程页面
 */

import { app, BrowserWindow } from "electron";
import { join } from "path";
import { existsSync } from "fs";
import {
  initIpcHandlers,
  stopAutomation,
  stopTriggers,
  stopWorkflows,
} from "./ipc";
import { initDatabase, closeDatabase } from "./db/sqlite";
import { stopTerminals } from "./terminal/manager";
import { purgeStaleWorkflowRuntimes } from "./workflow/artifacts";
import { migrateLegacyAssets } from "./migration/legacy-assets";

let mainWindow: BrowserWindow | null = null;

/**
 * 解析 preload 脚本路径。
 *
 * electron-vite 在不同模式下输出扩展名不同：
 * - dev 模式：out/preload/index.mjs（ESM）
 * - build 模式：out/preload/index.cjs（CJS，sandbox 兼容）
 *
 * 此处运行时按实际存在的文件解析，两种模式都能正确加载。
 */
function resolvePreloadPath(): string {
  const dir = join(__dirname, "../preload");
  for (const name of ["index.mjs", "index.cjs", "index.js"]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  // 兜底：理论上下一次 build 会重新生成
  return join(dir, "index.cjs");
}

function createWindow(): BrowserWindow {
  // 窗口/任务栏图标：打包后在 extraResources 里，开发时读项目根 resources/
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "logo.png")
    : join(__dirname, "../../resources/logo.png");

  const preloadPath = resolvePreloadPath();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    icon: iconPath,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: preloadPath,
      // 安全：渲染进程不开启 Node.js 集成
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow = win;

  win.on("ready-to-show", () => {
    win.show();
  });

  // 开发模式加载 dev server，生产模式加载打包文件
  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    // 默认不自动弹 DevTools；需要时用 NOVA_DEVTOOLS=1 启动，
    // 或运行时按 Ctrl+Shift+I 手动打开。
    if (process.env["NOVA_DEVTOOLS"] === "1") {
      win.webContents.openDevTools();
    }
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

app.whenReady().then(async () => {
  // 初始化数据库
  initDatabase();

  // 旧版 Nova MCP / Skill 主库 → Claude 配置（幂等，失败不影响启动）
  await migrateLegacyAssets();

  // IPC 层持有窗口引用（initIpcHandlers 内部会 setMainWindow），
  // 因此必须先把窗口创建出来再注册，顺序不能反。
  const win = createWindow();
  initIpcHandlers(win);

  // 清理异常退出遗留的运行时投影目录；不阻塞窗口加载
  void purgeStaleWorkflowRuntimes(app.getPath("userData"));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // 先停止自动化轮询定时器，避免应用退出后定时器仍在运行
  stopAutomation();
  stopTriggers();
  stopWorkflows();
  stopTerminals();
  closeDatabase();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
