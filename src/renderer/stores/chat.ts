/**
 * 对话状态管理
 *
 * 并发模型：每个会话有独立的消息桶与流式状态。
 * - messagesBySession / streamingBySession 按 sessionId 分桶
 * - 事件带 sessionId 到达，路由到对应桶（即便该会话不在前台也持续累积）
 * - 切换会话只换 currentSessionId，后台会话继续跑
 *
 * 数据模型：项目(Project) → 会话(Session) → 消息(Message[]，带 role)。
 * 流式 delta 通过 appendEvent 合并进对应会话当前 assistant 消息的块。
 */

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { newId } from "../lib/utils";
import { appendEvent } from "@shared/merge";
import type { AgentInfo } from "@shared/contracts/agent";
import type {
  AgentEvent,
  Message,
  Project,
  Session,
  SessionOptions,
} from "@shared/types";

interface ChatState {
  // 状态
  /** 主进程检测出的全部 Agent（manifest + 安装状态） */
  agents: AgentInfo[];
  projects: Project[];
  sessions: Session[];
  currentProjectId: string | null;
  currentSessionId: string | null;
  /** 每个会话的实时消息桶（含未落库的流式增量） */
  messagesBySession: Record<string, Message[]>;
  /** 每个会话是否正在流式运行（供会话列表并发指示、输入区按钮态） */
  streamingBySession: Record<string, boolean>;
  /** 正在回放历史的会话 id（供聊天区显示进度条；null 表示空闲） */
  loadingHistoryFor: string | null;
  /** 当前选中的 Agent；空字符串表示尚未确定 */
  selectedAgentId: string;
  /**
   * 每个 Agent 的运行时参数取值（键来自该 Agent 的 manifest.options）。
   * 宿主不理解键值含义，只负责按声明存取并原样回传。
   */
  optionValuesByAgent: Record<string, Record<string, string>>;
  /** 视图模式：会话 / 任务中心 / 数字员工 / 工作流 */
  viewMode: "chat" | "automation" | "employees" | "workflow" | "skills";
  /** 设置弹框是否展开 */
  showSettings: boolean;
  /** 右侧工作区文件面板是否展开 */
  showWorkspace: boolean;

  // 项目
  loadProjects: () => Promise<void>;
  createProject: (name: string, cwd: string) => Promise<Project | null>;
  deleteProject: (id: string) => Promise<void>;
  selectProject: (id: string) => void;
  newSession: () => void;
  pickDirectory: () => Promise<string | null>;

  // 会话
  loadSessions: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  /** 清空某项目下的全部会话 */
  clearProjectSessions: (projectId: string) => Promise<void>;

  // Agent
  detectAgents: () => Promise<void>;
  selectAgent: (id: string) => void;
  setAgentOption: (agentId: string, key: string, value: string) => void;
  clearAgentOptions: (agentId: string) => void;

  // 对话
  sendMessage: (prompt: string) => Promise<void>;
  abort: (sessionId?: string) => Promise<void>;

  // 视图
  setViewMode: (mode: "chat" | "automation" | "employees" | "workflow" | "skills") => void;
  setShowSettings: (show: boolean) => void;
  setShowWorkspace: (show: boolean) => void;

  // 内部
  _onEvent: (payload: { sessionId: string; event: AgentEvent }) => void;
  _onDone: (data: { sessionId: string }) => void;
}

const EMPTY: readonly Message[] = Object.freeze([]);

export const useChatStore = create<ChatState>((set, get) => ({
  agents: [],
  projects: [],
  sessions: [],
  currentProjectId: null,
  currentSessionId: null,
  messagesBySession: {},
  streamingBySession: {},
  loadingHistoryFor: null,
  selectedAgentId: "",
  optionValuesByAgent: {},
  viewMode: "chat",
  showSettings: false,
  showWorkspace: false,

  // ==========================================================================
  // 项目
  // ==========================================================================

  loadProjects: async () => {
    const projects = await ipc.listProjects();
    set({ projects });
    if (!get().currentProjectId && projects.length > 0) {
      set({ currentProjectId: projects[0].id });
    }
  },

  createProject: async (name, cwd) => {
    const project = await ipc.createProject(name, cwd);
    set((s) => ({ projects: [project, ...s.projects], currentProjectId: project.id }));
    await get().loadSessions();
    return project;
  },

  deleteProject: async (id) => {
    await ipc.deleteProject(id);
    set((state) => {
      const wasCurrent = state.currentProjectId === id;
      return {
        projects: state.projects.filter((p) => p.id !== id),
        sessions: state.sessions.filter((s) => s.projectId !== id),
        currentProjectId: wasCurrent
          ? (state.projects.find((p) => p.id !== id)?.id ?? null)
          : state.currentProjectId,
        currentSessionId: wasCurrent ? null : state.currentSessionId,
      };
    });
  },

  selectProject: (id) => {
    set({ currentProjectId: id, currentSessionId: null });
  },

  newSession: () => {
    // 只清空当前视图，不预建会话；首条消息时才 createSession，
    // 避免产生大量空会话
    set({ currentSessionId: null });
  },

  pickDirectory: () => ipc.pickDirectory(),

  // ==========================================================================
  // 会话
  // ==========================================================================

  loadSessions: async () => {
    set({ sessions: await ipc.listSessions() });
  },

  selectSession: async (id) => {
    // 点会话时立刻把项目选中态同步到该会话所属项目 ——
    // 不等历史回放，否则冷切换期间会话列表旧项目头的高亮仍在，看起来"没联动"。
    // projectId 从 store 里已持有的 sessions 查，不必等 ipc.getSession。
    const known = get().sessions.find((s) => s.id === id);
    if (known) {
      set({ currentSessionId: id, currentProjectId: known.projectId });
    } else {
      set({ currentSessionId: id });
    }

    // 已有实时桶：直接切换，无需回放历史
    if (get().messagesBySession[id]) return;
    // 同一会话的回放尚未返回时重复点击：忽略，避免重复发起
    if (get().loadingHistoryFor === id) return;

    // 乐观切换：先亮起选中态并进入"历史回放中"状态，历史到达后再填充消息。
    // 否则 await 期间界面毫无反馈，用户会误以为没点上而反复点击。
    set({ loadingHistoryFor: id });
    try {
      const session = await ipc.getSession(id);
      set((s) => ({
        messagesBySession: { ...s.messagesBySession, [id]: session?.messages ?? [] },
        currentProjectId: session?.projectId ?? s.currentProjectId,
        // 注意：不回写 selectedAgentId。selectedAgentId 现在唯一的语义是
        // 「新会话默认用谁」，只应由输入框旁的 Agent 选择器显式修改 ——
        // 浏览历史会话不应该悄悄改掉它（这正是旧侧栏选择器令人困惑的根源）。
        // 已开会话实际用哪个 Agent 由 selectEffectiveAgentId 从会话本身推导。
      }));
    } finally {
      // 只清除本次回放的标记（期间用户可能已切到别的会话）
      if (get().loadingHistoryFor === id) set({ loadingHistoryFor: null });
    }
  },

  renameSession: async (id, title) => {
    await ipc.renameSession(id, title);
    set((s) => ({
      sessions: s.sessions.map((se) => (se.id === id ? { ...se, title } : se)),
    }));
  },

  deleteSession: async (id) => {
    await ipc.deleteSession(id);
    set((s) => {
      const messagesBySession = { ...s.messagesBySession };
      delete messagesBySession[id];
      const streamingBySession = { ...s.streamingBySession };
      delete streamingBySession[id];
      return {
        sessions: s.sessions.filter((se) => se.id !== id),
        messagesBySession,
        streamingBySession,
        currentSessionId: s.currentSessionId === id ? null : s.currentSessionId,
      };
    });
  },

  clearProjectSessions: async (projectId) => {
    await ipc.clearProjectSessions(projectId);
    set((s) => {
      const removed = new Set(
        s.sessions.filter((se) => se.projectId === projectId).map((se) => se.id),
      );
      const messagesBySession = { ...s.messagesBySession };
      const streamingBySession = { ...s.streamingBySession };
      for (const id of removed) {
        delete messagesBySession[id];
        delete streamingBySession[id];
      }
      return {
        sessions: s.sessions.filter((se) => se.projectId !== projectId),
        messagesBySession,
        streamingBySession,
        // 被清掉的会话若正在前台，则回到"未选中"状态
        currentSessionId:
          s.currentSessionId && removed.has(s.currentSessionId) ? null : s.currentSessionId,
      };
    });
  },

  // ==========================================================================
  // Agent
  // ==========================================================================

  detectAgents: async () => {
    const agents = await ipc.detectAgents();
    set({ agents });

    const installed = agents.filter((a) => a.status.installed);
    if (installed.length === 0) return;

    // 从设置恢复上次选择的 Agent；未指定或已卸载则回退到第一个已安装的
    const settings = await ipc.getSettings();
    const saved = settings.defaultAgent;
    if (saved && installed.some((a) => a.id === saved)) {
      set({ selectedAgentId: saved });
    } else if (!installed.some((a) => a.id === get().selectedAgentId)) {
      set({ selectedAgentId: installed[0].id });
    }
  },

  selectAgent: (id) => {
    set({ selectedAgentId: id });
    void ipc.setSettings({ defaultAgent: id });
  },

  setAgentOption: (agentId, key, value) => {
    set((s) => ({
      optionValuesByAgent: {
        ...s.optionValuesByAgent,
        [agentId]: { ...s.optionValuesByAgent[agentId], [key]: value },
      },
    }));
  },

  clearAgentOptions: (agentId) => {
    set((s) => {
      const next = { ...s.optionValuesByAgent };
      delete next[agentId];
      return { optionValuesByAgent: next };
    });
  },

  // ==========================================================================
  // 对话
  // ==========================================================================

  sendMessage: async (prompt) => {
    const state = get();
    const currentId = state.currentSessionId;

    // 无会话 → 预创建一个，拿到 sessionId 再发（保证事件可路由）
    let sessionId: string;
    let agentId: string;
    if (currentId) {
      sessionId = currentId;
      // 已有会话：参数按该会话实际使用的 Agent 取，而不是当前选中的
      agentId = selectEffectiveAgentId(state);
    } else {
      if (!state.currentProjectId) return; // 无项目：ChatArea 空态已提示

      // Agent 由「当前选中 → 第一个已安装」推导，不硬编码任何具体 Agent
      const picked =
        state.selectedAgentId ||
        state.agents.find((a) => a.status.installed)?.id;
      if (!picked) return; // 没有可用 Agent
      agentId = picked;

      const session = await ipc.createSession(state.currentProjectId, agentId);
      sessionId = session.id;
      set((s) => ({
        currentSessionId: sessionId,
        messagesBySession: { ...s.messagesBySession, [sessionId]: [] },
        streamingBySession: { ...s.streamingBySession, [sessionId]: false },
      }));
      // 立即刷新会话列表，让新会话出现（不等跑完）
      void get().loadSessions();
    }

    // 用户消息入桶（带 role）
    const userMsg: Message = {
      id: newId(),
      role: "user",
      content: [{ type: "text", content: prompt }],
      timestamp: Date.now(),
    };
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...(s.messagesBySession[sessionId] ?? []), userMsg],
      },
      streamingBySession: { ...s.streamingBySession, [sessionId]: true },
    }));

    try {
      // 运行参数：键由该 Agent 的 manifest.options 声明，宿主只负责原样透传
      const opts: SessionOptions = get().optionValuesByAgent[agentId] ?? {};
      const result = await ipc.sendAgent(sessionId, prompt, opts);
      if (!result.ok) throw new Error(result.error);
      // done 事件会复位 streaming；此处不提前复位，避免中间闪烁
    } catch (err) {
      set((s) => ({
        streamingBySession: { ...s.streamingBySession, [sessionId]: false },
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: [
            ...(s.messagesBySession[sessionId] ?? []),
            {
              id: newId(),
              role: "assistant",
              content: [{ type: "error", message: String(err) }],
              timestamp: Date.now(),
            },
          ],
        },
      }));
    }
  },

  abort: async (sessionId) => {
    const id = sessionId ?? get().currentSessionId;
    if (!id) return;
    await ipc.abortAgent(id);
    set((s) => ({ streamingBySession: { ...s.streamingBySession, [id]: false } }));
  },

  // ==========================================================================
  // 视图
  // ==========================================================================

  setViewMode: (mode) => {
    set({ viewMode: mode });
  },

  setShowSettings: (show) => {
    set({ showSettings: show });
  },

  setShowWorkspace: (show) => {
    set({ showWorkspace: show });
  },

  // ==========================================================================
  // 内部回调 — 被 hooks 注册，按 sessionId 路由
  // ==========================================================================

  _onEvent: ({ sessionId, event }) => {
    // done 仅复位流状态，不入消息
    if (event.type === "done") {
      set((s) => ({ streamingBySession: { ...s.streamingBySession, [sessionId]: false } }));
      return;
    }

    set((state) => {
      const msgs = state.messagesBySession[sessionId] ?? [];
      const last = msgs[msgs.length - 1];
      // 当前轮进行中的 assistant 消息：合并事件进其 content
      if (last && last.role === "assistant" && state.streamingBySession[sessionId]) {
        const updated: Message = { ...last, content: appendEvent(last.content, event) };
        return {
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: [...msgs.slice(0, -1), updated],
          },
        };
      }
      const newMsg: Message = {
        id: newId(),
        role: "assistant",
        content: appendEvent([], event),
        timestamp: Date.now(),
      };
      return {
        messagesBySession: { ...state.messagesBySession, [sessionId]: [...msgs, newMsg] },
      };
    });
  },

  _onDone: (data: { sessionId: string }) => {
    set((s) => ({ streamingBySession: { ...s.streamingBySession, [data.sessionId]: false } }));
    // 刷新会话列表（标题/排序更新）
    void get().loadSessions();
  },
}));

/** 选择器：当前会话的消息（无会话时返回冻结空数组，避免无谓重渲染） */
export function selectCurrentMessages(s: ChatState): readonly Message[] {
  if (!s.currentSessionId) return EMPTY;
  return s.messagesBySession[s.currentSessionId] ?? EMPTY;
}

/** 选择器：当前会话是否在流式 */
export function selectCurrentStreaming(s: ChatState): boolean {
  if (!s.currentSessionId) return false;
  return !!s.streamingBySession[s.currentSessionId];
}

/**
 * 选择器：当前生效的 Agent id。
 * 已有会话时以会话记录的 Agent 为准（会话可能由自动化创建，未必等于当前选中项），
 * 否则用当前选中的 Agent。运行参数与发送目标都以此为准。
 */
export function selectEffectiveAgentId(s: ChatState): string {
  if (s.currentSessionId) {
    const session = s.sessions.find((x) => x.id === s.currentSessionId);
    if (session) return session.agentId;
  }
  return s.selectedAgentId;
}
