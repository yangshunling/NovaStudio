/**
 * Nova — 主进程入口
 *
 * 职责：
 * 1. 创建 BrowserWindow
 * 2. 初始化数据库
 * 3. 注册 IPC 处理器
 * 4. 加载渲染进程页面
 */

import { app, BrowserWindow, dialog, shell } from "electron";
import { join } from "path";
import { existsSync } from "fs";
import {
  attachMainWindow,
  initIpcHandlers,
  stopAgents,
  stopAutomation,
  stopTriggers,
  stopWorkflows,
} from "./ipc";
import { initDatabase, closeDatabase } from "./db/sqlite";
import { stopTerminals } from "./terminal/manager";
import { purgeStaleWorkflowRuntimes } from "./workflow/artifacts";
import { migrateLegacyAssets } from "./migration/legacy-assets";
import { syncKnowledgeIndex } from "./knowledge/catalog";
import { initUpdater } from "./updater";

let mainWindow: BrowserWindow | null = null;
/** 退出清理只执行一次：before-quit 与 will-quit 都可能被触发 */
let backgroundStopped = false;
let databaseClosed = false;

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
      // 会话在后台也要持续接收流式事件：窗口失焦 / 被遮挡时，
      // Chromium 默认会把定时器节流到 1 次/秒，切回来时会看到文字成块蹦出。
      backgroundThrottling: false,
    },
  });

  mainWindow = win;

  win.on("ready-to-show", () => {
    win.show();
  });

  /*
   * 渲染进程销毁后它持有的终端 id 也一起丢失，PTY 会变成无人认领的后台进程。
   * 窗口关闭 / 渲染进程崩溃时统一回收，避免 powershell.exe 越积越多。
   */
  win.on("closed", () => stopTerminals());
  win.webContents.on("render-process-gone", () => stopTerminals());

  /*
   * 导航守卫：窗口挂了 preload，远程页面一旦在此窗口打开就能拿到全部 IPC。
   * 只允许留在应用自己的页面，外部链接交给系统浏览器。
   */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url === win.webContents.getURL()) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
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

/** 启动主流程：数据库 → 迁移 → 窗口 → IPC → 后台清理/索引 */
async function bootstrap(): Promise<void> {
  initDatabase();
  await migrateLegacyAssets();

  // 先清理异常退出遗留的运行时目录（可能含凭证副本），再开放 IPC：
  // 单实例下启动瞬间不可能有活跃运行，可以安全地全部删除。
  await purgeStaleWorkflowRuntimes(app.getPath("userData"));

  // IPC 层持有窗口引用（initIpcHandlers 内部会绑定窗口），
  // 因此必须先把窗口创建出来再注册，顺序不能反。
  const win = createWindow();
  initIpcHandlers(win);

  // 更新器需要推送通道，必须在窗口与 IPC 绑定之后初始化
  initUpdater();

  // 后台补齐知识库全文索引：首次升级 / 外部新增的文件需要建一次索引
  void syncKnowledgeIndex().catch((err) => {
    console.warn(
      "[knowledge] 启动索引失败：",
      err instanceof Error ? err.message : String(err),
    );
  });
}

/** 退出前中断所有后台任务（不关闭数据库，避免收尾写入失败） */
function stopBackgroundTasks(): void {
  if (backgroundStopped) return;
  backgroundStopped = true;
  stopAutomation();
  stopAgents();
  stopTriggers();
  stopWorkflows();
  stopTerminals();
}

function closeDatabaseOnce(): void {
  if (databaseClosed) return;
  databaseClosed = true;
  closeDatabase();
}

/** 只允许单实例：多实例会互相把对方的运行记录标记为“已中断” */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0] ?? mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[nova] 启动失败：", err);
      dialog.showErrorBox("Nova Studio 启动失败", message);
      app.quit();
    });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createWindow();
      // 新窗口必须重新绑定推送目标；IPC handler 本身仍然有效
      attachMainWindow(win);
    }
  });

  app.on("window-all-closed", () => {
    // macOS 关窗不退出应用；Windows / Linux 退出走 before-quit 统一清理
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", stopBackgroundTasks);
  app.on("will-quit", closeDatabaseOnce);
}
