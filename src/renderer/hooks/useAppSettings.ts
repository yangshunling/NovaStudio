/**
 * 应用运行设置（非视觉类）
 *
 * 皮肤与字号由 useTheme 独立管理（需要在首帧前同步应用），这里只承载
 * 「改了要落到主进程、下次启动才读回来」的运行参数：默认工作目录、
 * 自动化并发 / 扫描周期 / 单次超时。
 *
 * 设置弹框里多个面板共享同一份状态，避免每个控件各自 getSettings()
 * 一次、各自维护 useState 的重复逻辑。
 */

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { toast } from "../stores/toast";
import { DEFAULT_SETTINGS, type AppSettings } from "@shared/types";

/** 本 store 负责的设置项；视觉类设置不在此列 */
export type RuntimeSettings = Pick<
  AppSettings,
  | "defaultCwd"
  | "automationConcurrency"
  | "automationPollIntervalSec"
  | "agentTimeoutMinutes"
>;

interface AppSettingsState extends RuntimeSettings {
  /** 是否已从主进程读过一次；未读之前控件展示默认值 */
  loaded: boolean;
  load: () => Promise<void>;
  /** 乐观更新：先改本地，失败时回滚并提示 */
  update: (patch: Partial<RuntimeSettings>) => Promise<void>;
}

const DEFAULTS: RuntimeSettings = {
  defaultCwd: DEFAULT_SETTINGS.defaultCwd,
  automationConcurrency: DEFAULT_SETTINGS.automationConcurrency,
  automationPollIntervalSec: DEFAULT_SETTINGS.automationPollIntervalSec,
  agentTimeoutMinutes: DEFAULT_SETTINGS.agentTimeoutMinutes,
};

export const useAppSettingsStore = create<AppSettingsState>((set, get) => ({
  ...DEFAULTS,
  loaded: false,

  load: async () => {
    try {
      const settings = await ipc.getSettings();
      set({
        defaultCwd: settings.defaultCwd ?? DEFAULTS.defaultCwd,
        automationConcurrency:
          settings.automationConcurrency && settings.automationConcurrency > 0
            ? settings.automationConcurrency
            : DEFAULTS.automationConcurrency,
        automationPollIntervalSec:
          settings.automationPollIntervalSec &&
          settings.automationPollIntervalSec > 0
            ? settings.automationPollIntervalSec
            : DEFAULTS.automationPollIntervalSec,
        agentTimeoutMinutes:
          settings.agentTimeoutMinutes && settings.agentTimeoutMinutes > 0
            ? settings.agentTimeoutMinutes
            : DEFAULTS.agentTimeoutMinutes,
        loaded: true,
      });
    } catch {
      // 读取失败时保留默认值，设置页仍可正常操作
      set({ loaded: true });
    }
  },

  update: async (patch) => {
    set(patch);
    try {
      await ipc.setSettings(patch);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "设置保存失败");
      // 以主进程为准回滚本地乐观值
      await get().load();
    }
  },
}));

/** 设置弹框挂载时调用一次：已加载过则直接复用 */
export function loadAppSettings(): Promise<void> {
  const state = useAppSettingsStore.getState();
  return state.loaded ? Promise.resolve() : state.load();
}
