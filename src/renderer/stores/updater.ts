/**
 * 全局应用更新状态
 *
 * 主进程是唯一状态源，这里维护一份渲染进程的常驻快照：侧栏红点、
 * 设置弹框分组与关于页都读同一份数据，而不是只有打开关于页才订阅。
 */

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { toast } from "./toast";
import type { UpdaterState } from "@shared/types";

interface UpdaterStore {
  state: UpdaterState | null;
}

export const useUpdaterStore = create<UpdaterStore>(() => ({ state: null }));

/** 需要提醒用户的阶段：有新版本、正在下载、已下载待安装 */
export function hasUpdateNotice(state: UpdaterState | null): boolean {
  return (
    state?.phase === "available" ||
    state?.phase === "downloading" ||
    state?.phase === "downloaded"
  );
}

/** 本次运行已提示过的版本，避免主进程重复推送时反复弹提醒 */
let notifiedVersion: string | null = null;
let started = false;

/** 写入快照；首次发现新版本时顺带弹一次全局提醒 */
export function setUpdaterState(next: UpdaterState): void {
  useUpdaterStore.setState({ state: next });

  if (next.phase !== "available" || !next.version) return;
  if (notifiedVersion === next.version) return;

  notifiedVersion = next.version;
  toast.info(`发现新版本 v${next.version}，可在「设置 → 关于与更新」中下载。`, 6000);
}

/** 应用启动时调用一次：读取快照并订阅主进程推送 */
export function initUpdaterSync(): void {
  if (started) return;
  started = true;

  void ipc
    .getUpdaterState()
    .then(setUpdaterState)
    .catch(() => {});
  ipc.on.updaterChanged(setUpdaterState);
}
