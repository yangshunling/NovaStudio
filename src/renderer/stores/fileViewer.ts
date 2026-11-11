/**
 * 文件预览标签状态
 *
 * activeTabId 为 null 表示显示对话；非 null 时可以是文件标签 id，
 * 也可以是终端标签 id（终端数据由 stores/terminal.ts 独立管理）。
 */

import { create } from "zustand";

export interface FileTab {
  kind: "file";
  id: string;
  projectId: string;
  relativePath: string;
  name: string;
}

export type CenterTab = FileTab;

interface FileViewerState {
  tabs: CenterTab[];
  activeTabId: string | null;

  openFile: (projectId: string, relativePath: string, name: string) => void;
  activateTab: (id: string | null) => void;
  closeTab: (id: string) => void;
  /** 批量关闭（关闭其他 / 左侧 / 右侧 / 全部）；活动标签由调用方重新指定 */
  closeTabs: (ids: string[]) => void;
  closeAll: () => void;
}

function tabId(projectId: string, relativePath: string): string {
  return `${projectId}:${relativePath}`;
}

export const useFileViewerStore = create<FileViewerState>((set) => ({
  tabs: [],
  activeTabId: null,

  openFile: (projectId, relativePath, name) => {
    const id = tabId(projectId, relativePath);
    set((state) => {
      const exists = state.tabs.some((tab) => tab.id === id);
      return {
        tabs: exists
          ? state.tabs
          : [...state.tabs, { kind: "file", id, projectId, relativePath, name }],
        activeTabId: id,
      };
    });
  },

  activateTab: (id) => {
    set({ activeTabId: id });
  },

  closeTab: (id) => {
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return state;

      const tabs = state.tabs.filter((tab) => tab.id !== id);
      if (state.activeTabId !== id) return { ...state, tabs };

      const next = tabs[Math.min(index, tabs.length - 1)];
      return { tabs, activeTabId: next?.id ?? null };
    });
  },

  closeTabs: (ids) => {
    if (ids.length === 0) return;
    const closing = new Set(ids);
    // activeTabId 不在这里挑后继：标签栏还要考虑终端标签，由调用方统一决定
    set((state) => ({
      tabs: state.tabs.filter((tab) => !closing.has(tab.id)),
    }));
  },

  closeAll: () => {
    set({ tabs: [], activeTabId: null });
  },
}));
