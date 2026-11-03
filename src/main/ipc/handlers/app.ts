/**
 * 应用信息 IPC：供「关于」页展示产品与运行环境版本。
 *
 * 版本号统一取主进程的 app.getVersion()，开发态与打包态都能拿到
 * package.json 里的真实版本，避免在渲染层再维护一份副本。
 */

import { app } from "electron";
import { handle } from "../register";

export function registerAppHandlers(): void {
  handle("app:info", () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  }));
}
