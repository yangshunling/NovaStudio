/**
 * 皮肤与界面字号（全局共享状态）
 *
 * 真值来源是主进程的设置（落在 SQLite）。localStorage 只作为**启动瞬间的缓存**：
 * 组件树首次渲染前先用缓存把皮肤贴上，避免等设置异步返回时闪一下默认皮肤；
 * 设置到达后以它为准并回写缓存。
 *
 * 主题是横切关注点，因此不做 prop 传递 —— 需要皮肤信息的组件直接调用
 * useTheme() / useSkin() 从 store 取值。
 */

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { DEFAULT_SETTINGS } from "@shared/types";
import type { SkinVariant } from "@shared/contracts/skin";
import { defaultSkinId, getSkin, hasSkin, skins } from "../skins/registry";

/** 启动缓存键（只缓存皮肤与字号，真值仍在主进程设置里） */
const CACHE_KEY = "nova-skin";

interface SkinState {
  /** 当前皮肤 id */
  currentTheme: string;
  /** 界面基准字号（px）：整套 UI 的缩放基准 */
  fontSize: number;
  /** 聊天记录区域的独立字号（px） */
  chatFontSize: number;

  load: () => Promise<void>;
  setTheme: (id: string) => void;
  setFontSize: (px: number) => void;
  setChatFontSize: (px: number) => void;
}

/**
 * 把皮肤写到 <html data-theme>，CSS 变量据此生效。
 *
 * 同时把皮肤的明暗属性写进 color-scheme：滚动条、原生 <select> 下拉、
 * 输入框光标等浏览器内置控件会据此选择深/浅配色。否则深色皮肤下
 * 这些控件仍是系统浅色外观，与皮肤明显割裂。
 */
function applyTheme(skin: SkinVariant): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", skin.id);
  root.style.colorScheme = skin.appearance;
}

/**
 * 应用全局基准字号。
 * 用内联样式写在 <html> 上 —— 优先级高于皮肤的 [data-theme] 规则，
 * 因此用户的字号设置能覆盖皮肤声明的基准值，且整套字号量表随之等比缩放。
 */
function applyFontSize(px: number): void {
  document.documentElement.style.setProperty("--c-font-size", `${px}px`);
}

/**
 * 应用聊天记录区域字号。
 * 同样写在 <html> 上，但只被 .ui-chat-scale 子树消费（见 styles/index.css）：
 * 该子树会在自己身上重声明字号量表，从而与全局字号互不影响。
 */
function applyChatFontSize(px: number): void {
  document.documentElement.style.setProperty("--c-chat-font-size", `${px}px`);
}

function writeCache(theme: string, fontSize: number, chatFontSize: number): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ theme, fontSize, chatFontSize }));
  } catch {
    // localStorage 不可用时忽略：只是少了启动缓存
  }
}

/** 读取启动缓存，非法值一律回退默认 */
function readCache(): {
  currentTheme: string;
  fontSize: number;
  chatFontSize: number;
} {
  const fallbackFontSize = DEFAULT_SETTINGS.fontSize;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        theme?: unknown;
        fontSize?: unknown;
        chatFontSize?: unknown;
      };
      const fontSize =
        typeof parsed.fontSize === "number" && parsed.fontSize > 0
          ? parsed.fontSize
          : fallbackFontSize;
      return {
        currentTheme:
          typeof parsed.theme === "string" && hasSkin(parsed.theme)
            ? parsed.theme
            : defaultSkinId,
        fontSize,
        // 老缓存没有聊天字号：跟随全局，保证升级后观感不变
        chatFontSize:
          typeof parsed.chatFontSize === "number" && parsed.chatFontSize > 0
            ? parsed.chatFontSize
            : fontSize,
      };
    }
  } catch {
    // 缓存损坏则回退默认
  }
  return {
    currentTheme: defaultSkinId,
    fontSize: fallbackFontSize,
    chatFontSize: DEFAULT_SETTINGS.chatFontSize,
  };
}

const cached = readCache();

export const useThemeStore = create<SkinState>((set, get) => ({
  currentTheme: cached.currentTheme,
  fontSize: cached.fontSize,
  chatFontSize: cached.chatFontSize,

  /** 从主进程设置同步（应用启动后调用一次），以设置里的值为准 */
  load: async () => {
    const settings = await ipc.getSettings();
    const theme =
      settings.theme && hasSkin(settings.theme) ? settings.theme : defaultSkinId;
    const fontSize =
      settings.fontSize && settings.fontSize > 0
        ? settings.fontSize
        : DEFAULT_SETTINGS.fontSize;
    // 未单独设置过聊天字号（老用户升级）：跟随全局字号，观感不变
    const chatFontSize =
      settings.chatFontSize && settings.chatFontSize > 0
        ? settings.chatFontSize
        : fontSize;

    set({ currentTheme: theme, fontSize, chatFontSize });
    applyTheme(getSkin(theme));
    applyFontSize(fontSize);
    applyChatFontSize(chatFontSize);
    writeCache(theme, fontSize, chatFontSize);
  },

  setTheme: (id) => {
    if (!hasSkin(id)) return;
    set({ currentTheme: id });
    applyTheme(getSkin(id));
    writeCache(id, get().fontSize, get().chatFontSize);
    void ipc.setSettings({ theme: id });
  },

  setFontSize: (px) => {
    if (!(px > 0)) return;
    set({ fontSize: px });
    applyFontSize(px);
    writeCache(get().currentTheme, px, get().chatFontSize);
    void ipc.setSettings({ fontSize: px });
  },

  setChatFontSize: (px) => {
    if (!(px > 0)) return;
    set({ chatFontSize: px });
    applyChatFontSize(px);
    writeCache(get().currentTheme, get().fontSize, px);
    void ipc.setSettings({ chatFontSize: px });
  },
}));

// 首次渲染前应用缓存值，避免无主题变量的 FOUC
applyTheme(getSkin(useThemeStore.getState().currentTheme));
applyFontSize(useThemeStore.getState().fontSize);
applyChatFontSize(useThemeStore.getState().chatFontSize);

/** 供应用启动时调用：从主进程设置同步皮肤与字号 */
export function loadSkinSettings(): Promise<void> {
  return useThemeStore.getState().load();
}

/** 皮肤列表与切换操作 */
export function useTheme() {
  const currentTheme = useThemeStore((s) => s.currentTheme);
  const fontSize = useThemeStore((s) => s.fontSize);
  const chatFontSize = useThemeStore((s) => s.chatFontSize);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setFontSize = useThemeStore((s) => s.setFontSize);
  const setChatFontSize = useThemeStore((s) => s.setChatFontSize);

  return {
    currentTheme,
    fontSize,
    chatFontSize,
    setTheme,
    setFontSize,
    setChatFontSize,
    skins,
  };
}

/** 当前皮肤的完整描述（需要 codeTheme / chrome 等元信息的组件使用） */
export function useSkin(): SkinVariant {
  return useThemeStore((s) => getSkin(s.currentTheme));
}
