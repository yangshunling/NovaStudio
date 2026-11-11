/**
 * 终端会话状态
 *
 * 终端标签显示在会话页的中心标签栏（对话 / 文件 / 终端），
 * 由 App 常驻挂载的会话页保持 PTY 不因切换页面而重启。
 *
 * 默认同一工作区只保留一个终端：再次「打开终端」时直接复用已有会话，
 * 避免用户重复点击时开出一堆同样的 Claude Code 实例；
 * 会话菜单里的「新建终端」传 forceNew，允许并排开多个标签。
 */

import { create } from "zustand";
import { newId } from "../lib/utils";

export interface TerminalSession {
  id: string;
  /** 归属的工作区（项目）id；未绑定工作区的会话为 null */
  workspaceId: string | null;
  cwd: string;
  name: string;
  /**
   * 重启计数。PTY 退出后需要重新创建进程，但标签 id 不变（保持标签顺序），
   * TerminalView 通过这个值感知「应该重开一个 shell」。
   */
  generation: number;
}

interface TerminalState {
  terminals: TerminalSession[];

  /**
   * 打开终端并返回其 id。
   * 默认同一工作区复用已有终端；forceNew 时总是新建（会话菜单的「新建终端」）。
   */
  open: (input: {
    workspaceId?: string | null;
    cwd: string;
    name?: string;
    forceNew?: boolean;
  }) => string;
  /** 关闭终端并销毁对应 PTY */
  close: (id: string) => void;
  /** 批量关闭；标签栏的「关闭其他 / 全部关闭」使用 */
  closeMany: (ids: string[]) => void;
  /** 在同一个标签里重新拉起 shell（PTY 退出后使用） */
  restart: (id: string) => void;
  /** 关闭某工作区下的所有终端（删除工作区时调用） */
  closeByWorkspace: (workspaceId: string) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],

  open: ({ workspaceId = null, cwd, name = "终端", forceNew = false }) => {
    const existing =
      !forceNew && workspaceId
        ? get().terminals.find((item) => item.workspaceId === workspaceId)
        : undefined;
    if (existing) return existing.id;

    const id = `terminal:${newId()}`;
    set((state) => ({
      terminals: [
        ...state.terminals,
        { id, workspaceId, cwd, name, generation: 0 },
      ],
    }));
    return id;
  },

  close: (id) => {
    set((state) => {
      if (!state.terminals.some((item) => item.id === id)) return state;
      return {
        terminals: state.terminals.filter((item) => item.id !== id),
      };
    });
  },

  closeMany: (ids) => {
    if (ids.length === 0) return;
    const closing = new Set(ids);
    set((state) => {
      const terminals = state.terminals.filter(
        (item) => !closing.has(item.id),
      );
      return terminals.length === state.terminals.length
        ? state
        : { terminals };
    });
  },

  restart: (id) => {
    set((state) => ({
      terminals: state.terminals.map((item) =>
        item.id === id ? { ...item, generation: item.generation + 1 } : item,
      ),
    }));
  },

  closeByWorkspace: (workspaceId) => {
    set((state) => {
      const terminals = state.terminals.filter(
        (item) => item.workspaceId !== workspaceId,
      );
      return terminals.length === state.terminals.length
        ? state
        : { terminals };
    });
  },
}));
