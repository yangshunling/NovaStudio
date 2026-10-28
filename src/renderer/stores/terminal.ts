/**
 * 终端会话状态
 *
 * 与文件预览标签分开：终端需要跨页面常驻（由 App 中的 TerminalsView 保持挂载），
 * 而文件标签只在会话页内使用。
 *
 * 同一工作区只保留一个终端：再次「打开终端」时直接切回已有会话，
 * 避免用户重复点击时开出一堆同样的 Claude Code 实例。
 */

import { create } from "zustand";
import { newId } from "../lib/utils";

export interface TerminalSession {
  id: string;
  /** 归属的工作区（项目）id；通过「新建终端」临时打开的目录为 null */
  workspaceId: string | null;
  cwd: string;
  name: string;
}

interface TerminalState {
  terminals: TerminalSession[];
  activeId: string | null;

  /** 打开终端；同一工作区已存在时直接激活并返回其 id */
  open: (input: {
    workspaceId?: string | null;
    cwd: string;
    name?: string;
  }) => string;
  activate: (id: string) => void;
  close: (id: string) => void;
  /** 关闭某工作区下的所有终端（删除工作区时调用） */
  closeByWorkspace: (workspaceId: string) => void;
  /** 同步工作区改名后的终端标题 */
  renameByWorkspace: (workspaceId: string, name: string) => void;
  closeAll: () => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],
  activeId: null,

  open: ({ workspaceId = null, cwd, name = "终端" }) => {
    const existing = workspaceId
      ? get().terminals.find((item) => item.workspaceId === workspaceId)
      : undefined;
    if (existing) {
      set({ activeId: existing.id });
      return existing.id;
    }

    const id = `terminal:${newId()}`;
    set((state) => ({
      terminals: [...state.terminals, { id, workspaceId, cwd, name }],
      activeId: id,
    }));
    return id;
  },

  activate: (id) => set({ activeId: id }),

  close: (id) => {
    set((state) => {
      const index = state.terminals.findIndex((item) => item.id === id);
      if (index < 0) return state;

      const terminals = state.terminals.filter((item) => item.id !== id);
      if (state.activeId !== id) return { ...state, terminals };

      const next =
        terminals[Math.min(index, terminals.length - 1)] ?? null;
      return { terminals, activeId: next?.id ?? null };
    });
  },

  closeByWorkspace: (workspaceId) => {
    set((state) => {
      const terminals = state.terminals.filter(
        (item) => item.workspaceId !== workspaceId,
      );
      if (terminals.length === state.terminals.length) return state;

      const activeStillOpen =
        state.activeId !== null &&
        terminals.some((item) => item.id === state.activeId);
      return {
        terminals,
        activeId: activeStillOpen
          ? state.activeId
          : (terminals[0]?.id ?? null),
      };
    });
  },

  renameByWorkspace: (workspaceId, name) => {
    set((state) => ({
      terminals: state.terminals.map((item) =>
        item.workspaceId === workspaceId ? { ...item, name } : item,
      ),
    }));
  },

  closeAll: () => set({ terminals: [], activeId: null }),
}));
