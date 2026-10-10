/**
 * 设置相关 IPC
 *
 * 键在 DB 里统一以字符串存储。每个设置项的编解码集中在 SETTING_CODECS：
 * 新增一个设置项只需在这里加一行（类型由 AppSettings 约束，漏写会编译报错），
 * 读取与写入的实现不需要改动。
 */

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
  previewFontSize: { encode: String, decode: (raw) => Number(raw) },
  automationConcurrency: { encode: String, decode: (raw) => Number(raw) },
  automationPollIntervalSec: { encode: String, decode: (raw) => Number(raw) },
  agentTimeoutMinutes: { encode: String, decode: (raw) => Number(raw) },
};

/** 参与持久化的设置键，由编解码表推导 —— 不需要单独维护一份列表 */
const SETTING_KEYS = Object.keys(SETTING_CODECS) as (keyof AppSettings)[];

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
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const codec = SETTING_CODECS[key as keyof AppSettings];
      if (!codec) continue;
      db.setSetting(key, codec.encode(value as never));
    }
    return true;
  });
}
