/*
 * afterPack 钩子：给 Windows 主程序写入图标与版本信息。
 *
 * 背景：package.json 里设置了 win.signAndEditExecutable = false。
 * 一旦打开，electron-builder 会在打包时用 app-builder 的 rcedit 改写
 * NovaStudio.exe 的资源（图标、FileDescription/ProductName、版本号），
 * 但 rcedit 需要先从 GitHub 下载 winCodeSign 压缩包，而该包里带 macOS
 * 的符号链接；在未开启「开发人员模式」/非管理员的 Windows 上解压会报
 * 「Cannot create symbolic link : 客户端没有所需的特权」，打包直接失败。
 *
 * 所以这里保持 signAndEditExecutable = false，改由本钩子在 afterPack 阶段
 * 用本机 electron-builder 缓存里已有的 rcedit 完成同样的资源改写：
 * - 不签名的前提下，效果与 electron-builder 内建流程一致；
 * - 不再依赖 winCodeSign 解压权限。
 *
 * 备注：若以后以管理员身份打包、或开启了开发人员模式，可以直接删掉
 * signAndEditExecutable: false 和本钩子，交回 electron-builder 处理。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** 在 electron-builder 缓存里找一份可用的 rcedit（任一版本目录均可） */
function findRcedit() {
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || process.env.HOME || "",
    "electron-builder",
    "Cache",
    "winCodeSign",
  );
  if (!fs.existsSync(cacheRoot)) return null;

  for (const dir of fs.readdirSync(cacheRoot)) {
    for (const name of ["rcedit-x64.exe", "rcedit-ia32.exe"]) {
      const candidate = path.join(cacheRoot, dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

module.exports = async function patchWinExe(context) {
  if (context.electronPlatformName !== "win32") return;

  const { packager } = context;
  const { appInfo } = packager;
  const exePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  if (!fs.existsSync(exePath)) {
    throw new Error(`[patch-win-exe] 找不到主程序：${exePath}`);
  }

  // 运行时窗口图标由 main 的 resolveWindowIcon() 读取。extraResources 当前
  // 落在 resources/resources/ 下，这里在构建期断言文件存在，避免打包布局
  // 与读取路径再次不一致时，只有客户安装后才发现标题栏图标空白。
  const runtimeIcons = [
    path.join(context.appOutDir, "resources", "resources", "logo.png"),
    path.join(context.appOutDir, "resources", "logo.png"),
  ];
  if (!runtimeIcons.some((p) => fs.existsSync(p))) {
    throw new Error(
      "[patch-win-exe] 安装包内缺少窗口图标，主进程将回退到默认图标。已检查：\n" +
        runtimeIcons.map((p) => `  - ${p}`).join("\n"),
    );
  }

  const rcedit = findRcedit();
  if (rcedit == null) {
    /*
     * 直接失败，不静默跳过。
     * 静默跳过的结果是「打包成功、安装包图标与版本信息却是 Electron 默认值」，
     * 这种降级在发版后才被发现（0.4.0 之前就出过窗口 logo 不显示的问题）。
     */
    throw new Error(
      "[patch-win-exe] 未找到 rcedit，无法写入图标/版本信息。\n" +
        "  先执行一次 `npx electron-builder --win --dir` 让 electron-builder 下载 winCodeSign，" +
        "或手动把 rcedit-x64.exe 放到缓存目录。\n" +
        "  这里选择直接失败：带着默认图标发版比打包失败更难发现。",
    );
  }

  // 图标由 electron-builder 从 win.icon 的 png 惰性转换成 ico（不依赖 winCodeSign）
  const iconPath = await packager.getIconPath();
  if (iconPath == null) {
    throw new Error(
      "[patch-win-exe] electron-builder 未解析出应用图标，拒绝产出无图标安装包。",
    );
  }

  const args = [
    exePath,
    "--set-version-string",
    "FileDescription",
    appInfo.productName,
    "--set-version-string",
    "ProductName",
    appInfo.productName,
    "--set-version-string",
    "InternalName",
    appInfo.productFilename,
    "--set-version-string",
    "OriginalFilename",
    "",
    "--set-file-version",
    appInfo.version,
    "--set-product-version",
    appInfo.version,
  ];

  if (appInfo.copyright) {
    args.push("--set-version-string", "LegalCopyright", appInfo.copyright);
  }
  if (appInfo.companyName) {
    args.push("--set-version-string", "CompanyName", appInfo.companyName);
  }
  args.push("--set-icon", iconPath);

  execFileSync(rcedit, args, { stdio: "inherit" });
  console.log(`[patch-win-exe] 已写入图标与版本信息：${path.basename(exePath)}`);
};
