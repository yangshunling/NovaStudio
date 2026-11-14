/**
 * Nova — 主进程入口
 *
 * 职责：
 * 1. 创建 BrowserWindow
 * 2. 初始化数据库
 * 3. 注册 IPC 处理器
 * 4. 加载渲染进程页面
 */

import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  protocol,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { join } from "path";
import { existsSync } from "fs";
import {
  attachMainWindow,
  denyPendingPermissions,
  hasActiveBackgroundWork,
  initIpcHandlers,
  stopTerminals,
} from "./ipc";
import { initDatabase, closeDatabase, getSetting } from "./db/sqlite";
import { closeAllWorkspaceWatchers } from "./files/watcher";
import { purgeLegacyWorkflowRuntimes } from "./workflow/artifacts";
import { migrateLegacyAssets } from "./migration/legacy-assets";
import { syncKnowledgeIndex } from "./knowledge/catalog";
import { initUpdater } from "./updater";
import { purgeStaleTempDirs } from "./utils/fs";
import { logLifecycle } from "./utils/lifecycle-log";
import { appLifecycle } from "./lifecycle";
import { onActivityChanged } from "./lifecycle/activity";
import { installWindowCloseGuard } from "./lifecycle/unsaved";
import { installQuitHandler } from "./lifecycle/quit";
import { errorMessage } from "../shared/error";
import { DEFAULT_WINDOW_BACKGROUND } from "../shared/skin-default";
import {
  ATTACHMENT_SCHEME,
  registerAttachmentProtocol,
} from "./attachments/protocol";

/*
 * 自定义协议必须在 app ready 之前声明特权；放在模块顶层是为了保证
 * 无论单实例检查是否通过，注册都发生在 ready 之前。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: ATTACHMENT_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
/** 知识库外部变更的后台索引同步（搜索路径不再扫盘） */
let knowledgeSyncTimer: NodeJS.Timeout | null = null;

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

/**
 * 解析窗口 / 任务栏图标路径。
 *
 * extraResources 当前是 `{ from: "resources", to: "resources" }`，打包后
 * 实际文件在 `<resourcesPath>/resources/logo.png`。这里按候选顺序查找，
 * 并保留根路径作为兼容项，避免以后调整打包布局时再次静默失效。
 *
 * 找不到时返回 undefined，让 BrowserWindow 回退到可执行文件内嵌图标；
 * 不能返回不存在的路径：Electron 会得到空 NativeImage，标题栏反而空白。
 */
function resolveWindowIcon(): string | undefined {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, "resources", "logo.png"),
        join(process.resourcesPath, "logo.png"),
      ]
    : [join(__dirname, "../../resources/logo.png")];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  console.warn(
    "[nova] 未找到窗口图标，回退到可执行文件内嵌图标。候选路径：",
    candidates.join(", "),
  );
  return undefined;
}

/**
 * 建窗时的底色：与渲染进程首帧主题保持一致，避免深色皮肤白闪。
 *
 * 渲染层每次换肤都会通过 window:setAppearance 写入 nativeAppearance，
 * 因此这里不再猜「哪个皮肤 id 是深色」；首次启动没有记录时使用共享默认值。
 */
function initialWindowBackground(): string {
  try {
    const appearance = getSetting("nativeAppearance");
    if (appearance === "dark") return "#000000";
    if (appearance === "light") return "#ffffff";

    /*
     * 升级兼容：旧版本只存了 theme，没有 nativeAppearance。
     * 仅在缺少新记录时按已知皮肤推断，避免昼间用户升级后的首帧变黑；
     * 新装（theme 为空）继续走共享默认值（夜间）。
     */
    const theme = getSetting("theme");
    if (theme === "classic-day") return "#ffffff";
    if (theme === "classic-night") return "#000000";
  } catch {
    // 数据库尚未初始化：走内置默认
  }
  return DEFAULT_WINDOW_BACKGROUND;
}

function createWindow(): BrowserWindow {
  // 窗口/任务栏图标：打包后在 extraResources 里，开发时读项目根 resources/
  const iconPath = resolveWindowIcon();

  const preloadPath = resolvePreloadPath();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // 三栏（侧栏 216 + 会话列表 268 + 工作区 240）在 1024 以下会把对话区挤没
    minWidth: 1024,
    minHeight: 600,
    show: false,
    backgroundColor: initialWindowBackground(),
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

  /*
   * 未保存改动的关窗确认：渲染层只登记「哪里没保存」，主进程负责询问与决定。
   * 详见 lifecycle/unsaved.ts 的设计约束。
   */
  installWindowCloseGuard(win);

  /*
   * 不变量：渲染层的 beforeunload **不得**否决关窗。
   *
   * Electron 对 beforeunload 的处理是静默取消关闭（不弹框、不报错），
   * 这正是本缺陷的成因。业务侧已不再依赖 beforeunload；这里作为兜底，
   * 忽略任何第三方/遗留监听，保证窗口永远关得掉。
   */
  win.webContents.on("will-prevent-unload", (event) => {
    logLifecycle("忽略渲染层 beforeunload 拦截（正常不应出现）");
    event.preventDefault();
  });

  win.on("ready-to-show", () => {
    win.show();
  });

  /*
   * 原生右键菜单。
   *
   * Electron 默认不弹任何菜单：用户在正文上框选后右键只会看到「什么也没有」，
   * 很容易判定为「这里不能复制」。这里只给最小可用的编辑动作；
   * 空白处（没有选区、也不是输入框）不弹菜单，避免打断阅读。
   */
  win.webContents.on("context-menu", (_event, params) => {
    const hasSelection = params.selectionText.trim().length > 0;
    const items: MenuItemConstructorOptions[] = [];
    if (hasSelection) items.push({ label: "复制", role: "copy" });
    if (params.isEditable) {
      if (hasSelection) items.push({ label: "剪切", role: "cut" });
      items.push({ label: "粘贴", role: "paste" });
    }
    if (hasSelection || params.isEditable) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push({ label: "全选", role: "selectAll" });
    }
    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  /*
   * 后台节流跟随真实负载：
   * - 有聊天 / 自动化 / 工作流在跑时必须保持全速（否则流式事件会成块到达）；
   * - 空闲时恢复 Chromium 默认节流，避免窗口失焦后仍全速跑定时器与动画。
   *
   * 运行开始 / 结束由 AgentService 与 WorkflowRunner 显式通知，不再轮询：
   * 轮询会让「开始运行」到「恢复全速」之间最多有 2 秒的节流窗口。
   */
  let lastThrottle: boolean | null = null;
  const applyThrottle = (): void => {
    if (win.isDestroyed()) return;
    const allowed = !hasActiveBackgroundWork();
    if (allowed === lastThrottle) return;
    lastThrottle = allowed;
    win.webContents.setBackgroundThrottling(allowed);
  };
  const offActivity = onActivityChanged(applyThrottle);
  applyThrottle();

  /*
   * 渲染进程销毁后它持有的终端 id 也一起丢失，PTY 会变成无人认领的后台进程。
   * 窗口关闭 / 渲染进程崩溃时统一回收，避免 powershell.exe 越积越多。
   */
  win.on("closed", () => {
    // 必须置空：否则退出清理期间再启动应用，second-instance 会拿到
    // 已销毁的窗口并调用 isMinimized()，抛异常后无法再开窗
    if (mainWindow === win) mainWindow = null;
    offActivity();
    stopTerminals();
    denyPendingPermissions();
  });
  win.webContents.on("render-process-gone", () => {
    stopTerminals();
    denyPendingPermissions();
  });

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
  // Windows 任务栏分组与通知身份；必须与 package.json 的 build.appId 一致，
  // 否则快捷方式与运行中的窗口会被系统认成两个应用。
  if (process.platform === "win32") {
    app.setAppUserModelId("com.nova.app");
  }

  initDatabase();
  // 会话图片附件协议：渲染层通过 nova-attachment:// 按需读取
  registerAttachmentProtocol();
  // 上次异常退出可能留下含系统提示词的临时目录（员工 / 知识库内容），先清掉
  purgeStaleTempDirs("novastudio-system-");
  await migrateLegacyAssets();

  // 清理旧版本遗留的 workflow-runs（含凭证副本），再开放 IPC：
  // 单实例下启动瞬间不可能有活跃运行，可以安全地全部删除。
  await purgeLegacyWorkflowRuntimes(app.getPath("userData"));

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
      errorMessage(err),
    );
  });

  /*
   * 外部编辑（用户直接在资源管理器里改文件）不会经过 Nova 的写入接口，
   * 因此用低频定时同步吸收；搜索本身不再扫盘。
   */
  knowledgeSyncTimer = setInterval(() => {
    void syncKnowledgeIndex().catch((err) => {
      console.warn("[knowledge] 后台索引同步失败：", errorMessage(err));
    });
  }, 5 * 60 * 1000);
  knowledgeSyncTimer.unref?.();

  /*
   * 退出步骤：本文件拥有的资源就地登记；IPC 层创建的资源在 initIpcHandlers
   * 里登记。顺序由 order 决定，关库必须是最后一步。
   */
  appLifecycle.register({
    name: "knowledge-index",
    order: 10,
    run: () => {
      if (!knowledgeSyncTimer) return;
      clearInterval(knowledgeSyncTimer);
      knowledgeSyncTimer = null;
    },
  });
  appLifecycle.register({
    name: "workspace-watchers",
    order: 60,
    run: closeAllWorkspaceWatchers,
  });
  appLifecycle.register({
    name: "database",
    order: 100,
    timeoutMs: 5_000,
    run: closeDatabase,
  });

  appLifecycle.markReady();
}

/** 只允许单实例：多实例会互相把对方的运行记录标记为“已中断” */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 已经在退出或还没启动完：不要建窗，前者会打断退出，后者会绕过 IPC 初始化
    if (!appLifecycle.isReady()) return;

    const existing = BrowserWindow.getAllWindows()[0];
    const win =
      existing ?? (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

    if (!win) {
      // 旧窗口已销毁但进程仍在（退出清理中）：重新开窗，而不是对
      // destroyed 窗口调 isMinimized() 直接抛异常
      logLifecycle("second-instance：没有存活窗口，重新创建");
      const recreated = createWindow();
      attachMainWindow(recreated);
      return;
    }

    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => {
      const message = errorMessage(err);
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

  // 退出编排全部在 lifecycle/quit：确认未保存 → 按注册顺序清理 → 关库 → 退出
  installQuitHandler();
}
