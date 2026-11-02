/**
 * 全局确认框状态
 *
 * 用 `<ConfirmDialog />` 渲染在应用内，而不是 `window.confirm()`。
 *
 * 为什么不用原生 confirm：
 * Windows 上 Chromium 的原生 JS 对话框是宿主窗口的子窗口，关闭时不会走
 * 常规的激活恢复链路，导致 BrowserWindow 在系统层面仍是“未激活”：
 * 光标能点进输入框，但键盘事件全部丢失，整个应用都无法输入，直到用户
 * alt-tab 切走再切回（见 electron#41602）。应用内弹窗没有这个窗口层级问题。
 *
 * 用法：
 *   if (!(await confirmDialog({ title: "删除？", tone: "danger" }))) return;
 */

import { create } from "zustand";

export type ConfirmTone = "default" | "danger";

export interface ConfirmOptions {
  /** 标题，一句话说明要做什么 */
  title: string;
  /** 补充说明，支持 \n 换行 */
  message?: string;
  /** 确认按钮文案，默认「确定」 */
  confirmLabel?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelLabel?: string;
  /** danger 时确认按钮使用危险色，用于删除等不可恢复操作 */
  tone?: ConfirmTone;
}

interface ConfirmRequest extends ConfirmOptions {
  id: string;
  resolve: (confirmed: boolean) => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  open: (options: ConfirmOptions) => Promise<boolean>;
  settle: (confirmed: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,

  open: (options) =>
    new Promise<boolean>((resolve) => {
      // 同一时刻只展示一个确认框：上一个按「取消」处理，
      // 避免旧 Promise 永远挂起导致调用方逻辑卡住
      get().settle(false);
      set({ request: { ...options, id: crypto.randomUUID(), resolve } });
    }),

  settle: (confirmed) => {
    const request = get().request;
    if (!request) return;
    set({ request: null });
    request.resolve(confirmed);
  },
}));

/** 面向调用方的便捷 API，可在任意模块（含非组件代码）中使用 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().open(options);
}
