/**
 * 设置相关 IPC
 *
 * 键在 DB 里统一以字符串存储。每个设置项的编解码集中在 SETTING_CODECS：
 * 新增一个设置项只需在这里加一行（类型由 AppSettings 约束，漏写会编译报错），
 * 读取与写入的实现不需要改动。
 */

import { nativeTheme } from "electron";
import type { AppSettings } from "../../../shared/types";
import * as db from "../../db/sqlite";
import { handle } from "../register";

/** 设置项编解码表 */
const SETTING_CODECS: {
  [K in keyof AppSettings]: {
    encode: (value: AppSettings[K]) => string;
    decode: (raw: string) => AppSettings[K];
  };
} = {
  defaultAgent: { encode: String, decode: (raw) => raw },
  defaultCwd: { encode: String, decode: (raw) => raw },
  theme: { encode: String, decode: (raw) => raw },
  fontSize: { encode: String, decode: (raw) => Number(raw) },
  chatFontSize: { encode: String, decode: (raw) => Number(raw) },
  terminalFontSize: { encode: String, decode: (raw) => Number(raw) },
  automationConcurrency: { encode: String, decode: (raw) => Number(raw) },
  automationPollIntervalSec: { encode: String, decode: (raw) => Number(raw) },
  agentTimeoutMinutes: { encode: String, decode: (raw) => Number(raw) },
};

/** 参与持久化的设置键，由编解码表推导 —— 不需要单独维护一份列表 */
const SETTING_KEYS = Object.keys(SETTING_CODECS) as (keyof AppSettings)[];

/**
 * 数值型设置的合法区间。
 *
 * IPC 是进程边界，不能假设调用方一定来自本项目的界面：
 * 非法值（NaN / 负数 / 超大值）必须在落库前夹紧，否则会变成
 * “0ms 超时”“并发 999”这类运行期故障。
 */
const INTEGER_LIMITS: Partial<Record<keyof AppSettings, [number, number]>> = {
  fontSize: [8, 64],
  chatFontSize: [8, 64],
  terminalFontSize: [8, 64],
  automationConcurrency: [1, 10],
  automationPollIntervalSec: [5, 600],
  agentTimeoutMinutes: [1, 1440],
};

function sanitizeSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): AppSettings[K] | undefined {
  const limits = INTEGER_LIMITS[key];
  if (limits) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return undefined;
    const [min, max] = limits;
    return Math.min(max, Math.max(min, Math.round(numeric))) as AppSettings[K];
  }

  // 字符串型设置：空串是合法值（表示「未指定」），只做 trim；
  // 类型不对时返回 undefined，由调用方明确报错，而不是悄悄丢掉。
  if (typeof value !== "string") return undefined;
  return value.trim() as AppSettings[K];
}

/** 读取单个设置项；未落库时返回 undefined */
function readSetting<K extends keyof AppSettings>(key: K): AppSettings[K] | undefined {
  const raw = db.getSetting(key);
  return raw === null ? undefined : SETTING_CODECS[key].decode(raw);
}

export function registerSettingsHandlers(): void {
  handle("settings:get", () => {
    const settings: Partial<AppSettings> = {};
    for (const key of SETTING_KEYS) {
      const value = readSetting(key);
      if (value !== undefined) Object.assign(settings, { [key]: value });
    }
    return settings;
  });

  handle("settings:set", (patch) => {
    /**
     * 先全量校验再统一落库：某个键非法时直接报错，而不是把它悄悄丢掉后
     * 仍返回成功 —— 那样用户会以为设置生效了，重启才发现没变。
     */
    const entries: { key: string; value: string }[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const typedKey = key as keyof AppSettings;
      const codec = SETTING_CODECS[typedKey];
      if (!codec) throw new Error(`未知的设置项：${key}`);

      const sanitized = sanitizeSetting(
        typedKey,
        value as AppSettings[typeof typedKey],
      );
      if (sanitized === undefined) {
        throw new Error(`设置项「${key}」的取值无效`);
      }
      entries.push({ key, value: codec.encode(sanitized as never) });
    }

    for (const entry of entries) db.setSetting(entry.key, entry.value);
    return true;
  });

  /**
   * 原生窗口装饰跟随皮肤明暗。
   * Windows 的标题栏、系统菜单等原生控件由 nativeTheme 决定配色；
   * 渲染层每次应用皮肤都会把 appearance 同步过来，因此昼夜切换即时生效。
   */
  handle("window:setAppearance", ({ appearance }) => {
    nativeTheme.themeSource = appearance;
    return true;
  });
}
