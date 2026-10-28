/**
 * 文件预览标签状态
 *
 * activeTabId 为 null 表示显示对话；文件标签只在当前聊天视图内保持。
 * 终端标签由 stores/terminal.ts 独立管理（需要跨页面常驻）。
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

  closeAll: () => {
    set({ tabs: [], activeTabId: null });
  },
}));
