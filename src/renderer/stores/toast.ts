/**
 * 全局 Toast 状态
 *
 * 任何模块都可以直接调用 `toast.success(...)` / `toast.error(...)`，
 * 不需要拿到组件引用。展示层由 App 顶层挂载的 <ToastViewport /> 统一渲染，
 * 因此整个工程只有一套提醒样式与位置（顶部居中）。
 *
 * 约定：
 * - 同时最多保留 MAX_TOASTS 条，新提醒插在最上面
 * - duration <= 0 表示不自动消失（需要用户手动关闭）
 */

import { create } from "zustand";

export type ToastTone = "success" | "error" | "info";

export interface ToastOptions {
  tone?: ToastTone;
  /** 自动消失时间（毫秒）；<= 0 表示常驻 */
  duration?: number;
}

export interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
}

interface ToastState {
  toasts: ToastItem[];
  show: (message: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const MAX_TOASTS = 4;
const DEFAULT_DURATION = 2400;

/** 每个 toast 的自动关闭定时器，手动关闭时要一并清理 */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  show: (message, options) => {
    const id = crypto.randomUUID();
    const duration = options?.duration ?? DEFAULT_DURATION;
    const item: ToastItem = {
      id,
      message,
      tone: options?.tone ?? "info",
    };

    set((state) => ({
      // 新提醒放在最上面；超出上限时丢弃最旧的
      toasts: [item, ...state.toasts].slice(0, MAX_TOASTS),
    }));

    if (duration > 0) {
      timers.set(
        id,
        setTimeout(() => get().dismiss(id), duration),
      );
    }
    return id;
  },

  dismiss: (id) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    set((state) => ({
      toasts: state.toasts.filter((item) => item.id !== id),
    }));
  },
}));

/** 面向调用方的便捷 API，可在任意模块（含非组件代码）中使用 */
export const toast = {
  show: (message: string, options?: ToastOptions) =>
    useToastStore.getState().show(message, options),
  success: (message: string, duration?: number) =>
    useToastStore.getState().show(message, { tone: "success", duration }),
  error: (message: string, duration?: number) =>
    useToastStore.getState().show(message, { tone: "error", duration }),
  info: (message: string, duration?: number) =>
    useToastStore.getState().show(message, { tone: "info", duration }),
};
