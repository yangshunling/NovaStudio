/**
 * 应用更新 IPC：查询状态 / 检查 / 下载 / 重启安装
 *
 * 具体状态机与 electron-updater 的接线都在 main/updater.ts，本层只做转发。
 */

import {
  checkForUpdates,
  downloadUpdate,
  getUpdaterState,
  installUpdate,
} from "../../updater";
import { handle } from "../register";

export function registerUpdaterHandlers(): void {
  handle("updater:state", () => getUpdaterState());
  handle("updater:check", () => checkForUpdates());
  handle("updater:download", () => downloadUpdate());
  handle("updater:install", () => installUpdate());
}
