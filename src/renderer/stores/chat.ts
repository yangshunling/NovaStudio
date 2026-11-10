/**
 * 对话状态管理
 *
 * 并发模型：每个会话有独立的消息桶与流式状态。
 * - messagesBySession / streamingBySession 按 sessionId 分桶
 * - 事件带 sessionId 到达，路由到对应桶（即便该会话不在前台也持续累积）
 * - 切换会话只换 currentSessionId，后台会话继续跑
 *
 * 数据模型：会话(Session) → 消息(Message[]，带 role)。
 * 会话可选地绑定项目(Project = 工作目录)：项目不再出现在会话列表层级里，
 * 而是在会话输入框处按需绑定，因此 currentProjectId 表示「当前会话的工作目录」，
 * 未选中会话时表示「新会话将要绑定的项目」。
 * 流式 delta 通过 appendEvent 合并进对应会话当前 assistant 消息的块。
 */

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { newId } from "../lib/utils";
import { appendEvent } from "@shared/agent-events";
import type { AgentInfo } from "@shared/contracts/agent";
import type { AgentEvent, Message, Project, Session } from "@shared/types";

/** 主视图标识：state 与 setter 共用，避免联合类型各写一份 */
export type ViewMode =
  | "chat"
  | "todos"
  | "automation"
  | "employees"
  | "workflow"
  | "triggers"
  | "skills"
  | "mcp"
  | "prompts"
  | "knowledge"
  | "workspaces"
  | "agents";

/** 尚未创建会话时的草稿桶 key；UUID 会话 id 不会与之冲突 */
export const NEW_SESSION_DRAFT_KEY = "__new__";

interface ChatState {
  // 状态
  /** 主进程检测出的全部 Agent（manifest + 安装状态） */
  agents: AgentInfo[];
  projects: Project[];
  sessions: Session[];
  /** 当前会话绑定的项目；新会话态下表示首条消息将使用的项目 */
  currentProjectId: string | null;
  currentSessionId: string | null;
  /** 每个会话的实时消息桶（含未落库的流式增量） */
  messagesBySession: Record<string, Message[]>;
  /** 每个会话的 token 用量与上下文占用；随 usage 事件增量更新 */
  usageBySession: Record<string, SessionUsage>;
  /** 每个会话的输入草稿；切走再回来不丢，也不会串到别的会话 */
  draftsBySession: Record<string, string>;
  /** 每个会话是否正在流式运行（供会话列表并发指示、输入区按钮态） */
  streamingBySession: Record<string, boolean>;
  /** 正在回放历史的会话 id（供聊天区显示进度条；null 表示空闲） */
  loadingHistoryFor: string | null;
  /** 当前选中的 Agent；空字符串表示尚未确定 */
  selectedAgentId: string;
  /** 视图模式：会话 / 待办 / 任务中心 / 数字员工 / 工作流 …（终端在会话页内） */
  viewMode: ViewMode;
  /** 设置弹框是否展开 */
  showSettings: boolean;
  /** 右侧工作区文件面板是否展开 */
  showWorkspace: boolean;
  /** 项目 / 会话是否已成功加载过；工作区页据此跳过重复加载与启动骨架 */
  projectsLoaded: boolean;
  sessionsLoaded: boolean;
  /** 从「提示词」页带到会话输入框的正文；ChatArea 消费后清空 */
  pendingPrompt: string | null;

  // 项目（工作目录）
  loadProjects: () => Promise<void>;
  createProject: (name: string, cwd: string) => Promise<Project | null>;
  deleteProject: (id: string) => Promise<void>;
  /** 把当前会话（或新会话草稿）绑定到指定项目；null 表示解绑 */
  bindProject: (projectId: string | null) => Promise<void>;
  newSession: () => void;
  pickDirectory: () => Promise<string | null>;

  // 会话
  loadSessions: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  /** 置顶 / 取消置顶；只影响列表排序，不参与时间分组 */
  pinSession: (id: string, pinned: boolean) => Promise<void>;

  // Agent
  detectAgents: () => Promise<void>;
  selectAgent: (id: string) => void;

  // 对话
  sendMessage: (prompt: string) => Promise<void>;
  abort: (sessionId?: string) => Promise<void>;
  /** 写入某个会话（或新会话草稿桶）的输入草稿 */
  setDraft: (key: string, value: string) => void;

  // 视图
  setViewMode: (mode: ViewMode) => void;
  setShowSettings: (show: boolean) => void;
  setShowWorkspace: (show: boolean) => void;

  // 提示词
  /** 把提示词正文带到会话页并切到会话视图（不自动发送） */
  usePromptInChat: (content: string) => void;
  /** 取出待插入正文；取到后清空，避免重复插入 */
  consumePendingPrompt: () => string | null;

  // 内部
  _onEvent: (payload: { sessionId: string; event: AgentEvent }) => void;
  _onDone: (data: { sessionId: string }) => void;
}

const EMPTY: readonly Message[] = Object.freeze([]);

/** 一次 usage 事件（整轮汇总或单次调用的上下文快照） */
type UsageEvent = Extract<AgentEvent, { type: "usage" }>;

/**
 * 单个会话的用量汇总。
 *
 * 两个口径分开记：
 * - contextUsed / contextMax：最近一次 API 调用的上下文占用，用于仪表；
 * - input/output/cache/cost：整轮 result 的累加，用于「会话累计」。
 * 不能把整轮汇总当上下文占用：一轮里可能发生多次工具循环。
 */
export interface SessionUsage {
  /** 最近一次 API 调用的上下文占用（输入 + 缓存创建 + 缓存读取） */
  contextUsed: number;
  /** 上下文窗口上限；CLI 未报告时使用默认值 */
  contextMax: number;
  /** contextMax 是否来自 CLI 的明确报告（否则为默认值，应由模型配置覆盖） */
  contextMaxReported: boolean;
  /** 最近一次 API 调用的输入侧明细，用于 hover 面板 */
  contextInputTokens: number;
  contextCacheCreationInputTokens: number;
  contextCacheReadInputTokens: number;
  contextOutputTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  /** 已完成的问答轮数（按整轮 usage 计） */
  turns: number;
}

/** Claude Code 未报告 contextWindow 时的保守上限 */
const DEFAULT_CONTEXT_WINDOW = 200_000;

function emptyUsage(): SessionUsage {
  return {
    contextUsed: 0,
    contextMax: DEFAULT_CONTEXT_WINDOW,
    contextMaxReported: false,
    contextInputTokens: 0,
    contextCacheCreationInputTokens: 0,
    contextCacheReadInputTokens: 0,
    contextOutputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}

function applyUsage(
  previous: SessionUsage | undefined,
  event: UsageEvent,
): SessionUsage {
  const base = previous ?? emptyUsage();
  const context = event.inputTokens + event.cacheCreationInputTokens + event.cacheReadInputTokens;

  if (event.scope === "context") {
    return {
      ...base,
      contextUsed: context,
      contextInputTokens: event.inputTokens,
      contextCacheCreationInputTokens: event.cacheCreationInputTokens,
      contextCacheReadInputTokens: event.cacheReadInputTokens,
      contextOutputTokens: event.outputTokens,
    };
  }

  return {
    ...base,
    /*
     * 整轮汇总绝不能当上下文占用：一轮里可能发生多次工具循环，
     * result.usage 是这些调用的累加，会轻松超过窗口上限（表现为 122%）。
     * 上下文只由 scope: "context" 的快照更新；没有快照时保持 0，
     * 仪表隐藏，而不是显示一个错误数字。
     */
    contextMax: event.contextWindow && event.contextWindow > 0
      ? event.contextWindow
      : base.contextMax,
    contextMaxReported: event.contextWindow
      ? true
      : base.contextMaxReported,
    inputTokens: base.inputTokens + event.inputTokens,
    outputTokens: base.outputTokens + event.outputTokens,
    cacheCreationInputTokens:
      base.cacheCreationInputTokens + event.cacheCreationInputTokens,
    cacheReadInputTokens: base.cacheReadInputTokens + event.cacheReadInputTokens,
    costUsd: base.costUsd + (event.costUsd ?? 0),
    turns: base.turns + 1,
  };
}

/** 从历史消息里重建用量（冷启动 / 首次打开旧会话时） */
function summarizeUsage(messages: Message[]): SessionUsage | undefined {
  let usage: SessionUsage | undefined;
  for (const message of messages) {
    for (const event of message.content) {
      if (event.type === "usage") usage = applyUsage(usage, event);
    }
  }
  return usage;
}

/**
 * 流式事件的渲染层聚合。
 *
 * 主进程按 16ms 窗口推送，但每个事件仍是独立的 IPC 消息；渲染进程里每个 IPC
 * 回调都是独立任务，React 无法跨任务自动合批。于是一个 token 一个事件时，
 * 就变成每秒几十次完整渲染（每次还要重解析 Markdown）。
 *
 * 这里把短窗口内到达的事件合并成**一次** store 更新：渲染频率降到与帧率同阶，
 * 而消息内容仍然按原顺序逐条 appendEvent，语义不变。
 */
const EVENT_FLUSH_MS = 16;
let pendingEvents: Array<{ sessionId: string; event: AgentEvent }> = [];
let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushPendingEvents(): void {
  if (pendingFlushTimer) {
    clearTimeout(pendingFlushTimer);
    pendingFlushTimer = null;
  }
  if (pendingEvents.length === 0) return;

  // 先摘出队列再处理：处理过程中新到达的事件留到下一批
  const batch = pendingEvents;
  pendingEvents = [];

  useChatStore.setState((state) => {
    /* 同一会话的事件合并到一次 appendEvent 链上，避免逐事件复制数组 */
    const bySession = new Map<string, AgentEvent[]>();
    for (const { sessionId, event } of batch) {
      const list = bySession.get(sessionId);
      if (list) list.push(event);
      else bySession.set(sessionId, [event]);
    }

    const messagesBySession = { ...state.messagesBySession };
    const streamingBySession = { ...state.streamingBySession };
    const usageBySession = { ...state.usageBySession };

    for (const [sessionId, events] of bySession) {
      // 用量与消息分开累计：上下文快照只改 contextUsed，
      // 整轮 result 才累加 input/output/cost 与上下文上限。
      let usage = usageBySession[sessionId];
      let usageChanged = false;
      for (const event of events) {
        if (event.type !== "usage") continue;
        usage = applyUsage(usage, event);
        usageChanged = true;
      }
      if (usageChanged && usage) usageBySession[sessionId] = usage;

      const msgs = messagesBySession[sessionId] ?? [];
      const last = msgs[msgs.length - 1];

      if (last && last.role === "assistant") {
        let content = last.content;
        for (const event of events) content = appendEvent(content, event);
        messagesBySession[sessionId] = [...msgs.slice(0, -1), { ...last, content }];
        continue;
      }

      let content: AgentEvent[] = [];
      for (const event of events) content = appendEvent(content, event);
      messagesBySession[sessionId] = [
        ...msgs,
        { id: newId(), role: "assistant", content, timestamp: Date.now() },
      ];
      // 未知会话收到事件（例如运行中刷新）：恢复“正在执行”状态
      streamingBySession[sessionId] = true;
    }

    return { messagesBySession, streamingBySession, usageBySession };
  });
}

export const useChatStore = create<ChatState>((set, get) => ({
  agents: [],
  projects: [],
  sessions: [],
  currentProjectId: null,
  currentSessionId: null,
  messagesBySession: {},
  usageBySession: {},
  draftsBySession: {},
  streamingBySession: {},
  loadingHistoryFor: null,
  selectedAgentId: "",
  viewMode: "chat",
  showSettings: false,
  showWorkspace: false,
  projectsLoaded: false,
  sessionsLoaded: false,
  pendingPrompt: null,

  // ==========================================================================
  // 项目
  // ==========================================================================

  loadProjects: async () => {
    // 项目只作为「可绑定的工作目录」存在，不再自动选中第一个：
    // 新会话默认不绑定项目，用户需要时在输入框处选择。
    const projects = await ipc.listProjects();
    set({ projects, projectsLoaded: true });
  },

  createProject: async (name, cwd) => {
    const project = await ipc.createProject(name, cwd);
    set((s) => ({ projects: [project, ...s.projects] }));
    return project;
  },

  deleteProject: async (id) => {
    await ipc.deleteProject(id);
    set((state) => {
      // 删除项目会级联删除其下所有会话，渲染层同步清空对应消息桶
      const removed = new Set(
        state.sessions.filter((s) => s.projectId === id).map((s) => s.id),
      );
      const messagesBySession = { ...state.messagesBySession };
      const streamingBySession = { ...state.streamingBySession };
      const usageBySession = { ...state.usageBySession };
      const draftsBySession = { ...state.draftsBySession };
      for (const sessionId of removed) {
        delete messagesBySession[sessionId];
        delete streamingBySession[sessionId];
        delete usageBySession[sessionId];
        delete draftsBySession[sessionId];
      }
      return {
        projects: state.projects.filter((p) => p.id !== id),
        sessions: state.sessions.filter((s) => s.projectId !== id),
        messagesBySession,
        streamingBySession,
        usageBySession,
        draftsBySession,
        currentProjectId: state.currentProjectId === id ? null : state.currentProjectId,
        currentSessionId:
          state.currentSessionId && removed.has(state.currentSessionId)
            ? null
            : state.currentSessionId,
        loadingHistoryFor:
          state.loadingHistoryFor && removed.has(state.loadingHistoryFor)
            ? null
            : state.loadingHistoryFor,
      };
    });
  },

  bindProject: async (projectId) => {
    const state = get();
    const sessionId = state.currentSessionId;

    // 新会话草稿：只记下选择，首条消息创建会话时一并写入
    if (!sessionId) {
      set({ currentProjectId: projectId });
      return;
    }

    if (state.streamingBySession[sessionId]) {
      throw new Error("会话正在运行，请先停止再切换项目");
    }

    const session = await ipc.setSessionProject(sessionId, projectId);
    if (!session) throw new Error("会话不存在");

    set((s) => ({
      currentProjectId: session.projectId,
      sessions: s.sessions.map((se) =>
        se.id === session.id
          ? {
              ...se,
              projectId: session.projectId,
              cwd: session.cwd,
              agentSessionId: session.agentSessionId,
              updatedAt: session.updatedAt,
            }
          : se,
      ),
    }));
  },

  newSession: () => {
    // 只清空当前视图，不预建会话；首条消息时才 createSession，
    // 避免产生大量空会话。新会话默认不绑定项目。
    // 显式「新建」意味着放弃上一份未发送草稿，避免下次进来又看到旧内容。
    set((state) => {
      if (!(NEW_SESSION_DRAFT_KEY in state.draftsBySession)) {
        return { currentSessionId: null, currentProjectId: null };
      }
      const draftsBySession = { ...state.draftsBySession };
      delete draftsBySession[NEW_SESSION_DRAFT_KEY];
      return {
        currentSessionId: null,
        currentProjectId: null,
        draftsBySession,
      };
    });
  },

  pickDirectory: () => ipc.pickDirectory(),

  // ==========================================================================
  // 会话
  // ==========================================================================

  loadSessions: async () => {
    const sessions = await ipc.listSessions();
    set({ sessions, sessionsLoaded: true });
  },

  selectSession: async (id) => {
    // 点会话时立刻同步该项目绑定态，不等历史回放 —— 否则冷切换期间
    // 输入框旁的项目标签仍是上一个会话的，看起来"没联动"。
    // projectId 从 store 里已持有的 sessions 查，不必等 ipc.getSession。
    const known = get().sessions.find((s) => s.id === id);
    if (known) {
      set({ currentSessionId: id, currentProjectId: known.projectId });
    } else {
      set({ currentSessionId: id });
    }
    /*
     * 回放期间用户可能刚选过工作区（bindProject 会立刻改 currentProjectId）。
     * 记下进入回放时的绑定值，回放结果回来时据此判断绑定态有没有被用户改过——
     * 不能用「选择之前」的旧快照把刚绑定的工作区覆盖掉。
     * known 不存在时沿用 store 里的现有值，保证旧会话残留的绑定也能被回放结果纠正。
     */
    const replayBaseProjectId = known ? known.projectId : get().currentProjectId;

    // 已有实时桶：直接切换，无需回放历史。
    // 但如果用量还没建立（例如刚重启后第一次点开），从消息里补建一次。
    if (get().messagesBySession[id]) {
      if (!get().usageBySession[id]) {
        const usage = summarizeUsage(get().messagesBySession[id]);
        if (usage) {
          set((s) => ({
            usageBySession: { ...s.usageBySession, [id]: usage },
          }));
        }
      }
      return;
    }
    // 同一会话的回放尚未返回时重复点击：忽略，避免重复发起
    if (get().loadingHistoryFor === id) return;

    // 乐观切换：先亮起选中态并进入"历史回放中"状态，历史到达后再填充消息。
    // 否则 await 期间界面毫无反馈，用户会误以为没点上而反复点击。
    set({ loadingHistoryFor: id });
    try {
      const session = await ipc.getSession(id);
      set((s) => {
        const history = session?.messages ?? [];
        const existing = s.messagesBySession[id];
        // 回放期间用户可能已经发出了消息：保留这些新消息，避免被历史覆盖
        const merged = existing
          ? [
              ...history,
              ...existing.filter(
                (message) => !history.some((item) => item.id === message.id),
              ),
            ]
          : history;
        const usage = summarizeUsage(merged);
        return {
          messagesBySession: { ...s.messagesBySession, [id]: merged },
          usageBySession: usage
            ? { ...s.usageBySession, [id]: usage }
            : s.usageBySession,
          /*
           * 历史回放返回最新的绑定态（会话可能在别处被改过）。
           * 但如果回放期间用户自己选了工作区，bindProject 已经把
           * currentProjectId 改掉，此时 getSession 的返回值是「选择之前」
           * 的快照，直接写回会把刚绑定的工作区打回「指定工作区」。
           * 因此只在绑定态仍是乐观值时采用回放结果。
           */
          currentProjectId:
            s.currentSessionId !== id
              ? s.currentProjectId
              : s.currentProjectId === replayBaseProjectId
                ? (session?.projectId ?? null)
                : s.currentProjectId,
        // 注意：不回写 selectedAgentId。selectedAgentId 现在唯一的语义是
        // 「新会话默认用谁」，只应由输入框旁的 Agent 选择器显式修改 ——
        // 浏览历史会话不应该悄悄改掉它（这正是旧侧栏选择器令人困惑的根源）。
          // 已开会话实际用哪个 Agent 由 selectEffectiveAgentId 从会话本身推导。
        };
      });
    } catch (err) {
      // 回放失败不写入空桶，下一次点击会话仍可重试
      console.error("[chat] 历史回放失败", err);
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

  pinSession: async (id, pinned) => {
    const ok = await ipc.setSessionPinned(id, pinned);
    if (!ok) return;
    set((s) => ({
      sessions: s.sessions.map((se) =>
        se.id === id ? { ...se, pinnedAt: pinned ? Date.now() : null } : se,
      ),
    }));
  },

  deleteSession: async (id) => {
    await ipc.deleteSession(id);
    set((s) => {
      const messagesBySession = { ...s.messagesBySession };
      delete messagesBySession[id];
      const streamingBySession = { ...s.streamingBySession };
      delete streamingBySession[id];
      const usageBySession = { ...s.usageBySession };
      delete usageBySession[id];
      const draftsBySession = { ...s.draftsBySession };
      delete draftsBySession[id];
      const wasCurrent = s.currentSessionId === id;
      // 删除当前会话后输入区回到「新会话」态：不要翻出更早遗留的新会话草稿
      if (wasCurrent) delete draftsBySession[NEW_SESSION_DRAFT_KEY];
      return {
        sessions: s.sessions.filter((se) => se.id !== id),
        messagesBySession,
        streamingBySession,
        usageBySession,
        draftsBySession,
        currentSessionId: wasCurrent ? null : s.currentSessionId,
        currentProjectId: wasCurrent ? null : s.currentProjectId,
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

  // ==========================================================================
  // 对话
  // ==========================================================================

  sendMessage: async (prompt) => {
    const state = get();
    const currentId = state.currentSessionId;

    // 同一会话不允许并发发送：主进程按 sessionId 只保留一个运行句柄，
    // 第二次发送会覆盖运行记录，导致中断与状态都不正确。
    if (currentId && state.streamingBySession[currentId]) return;

    // 无会话 → 预创建一个，拿到 sessionId 再发（保证事件可路由）
    let sessionId: string;
    let agentId: string;
    if (currentId) {
      sessionId = currentId;
      // 已有会话：参数按该会话实际使用的 Agent 取，而不是当前选中的
      agentId = selectEffectiveAgentId(state);
    } else {
      // Agent 由「当前选中 → 第一个已安装」推导，不硬编码任何具体 Agent
      const picked =
        state.selectedAgentId ||
        state.agents.find((a) => a.status.installed)?.id;
      // 抛给调用方：此时还没有会话，无法把错误写进消息流
      if (!picked) throw new Error("未检测到可用的 Agent，请先完成安装或在 Agent 配置中选择");
      agentId = picked;

      // 项目可空：未绑定时主进程会回退到默认目录
      const session = await ipc.createSession(state.currentProjectId, agentId);
      sessionId = session.id;
      set((s) => ({
        currentSessionId: sessionId,
        currentProjectId: session.projectId,
        messagesBySession: { ...s.messagesBySession, [sessionId]: [] },
        streamingBySession: { ...s.streamingBySession, [sessionId]: false },
      }));
      // 立即刷新会话列表，让新会话出现（不等跑完）
      void get()
        .loadSessions()
        .catch((err) => console.warn("[chat] 会话列表刷新失败", err));
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
      // 运行方式完全由 Agent 平台的本机配置决定，会话不再单独传运行参数
      const result = await ipc.sendAgent(sessionId, prompt);
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

  setDraft: (key, value) => {
    set((state) => {
      if ((state.draftsBySession[key] ?? "") === value) return state;
      if (!value) {
        if (!(key in state.draftsBySession)) return state;
        const draftsBySession = { ...state.draftsBySession };
        delete draftsBySession[key];
        return { draftsBySession };
      }
      return {
        draftsBySession: { ...state.draftsBySession, [key]: value },
      };
    });
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
  // 提示词
  // ==========================================================================

  usePromptInChat: (content) => {
    const text = content.trim();
    if (!text) return;
    set({ pendingPrompt: text, viewMode: "chat" });
  },

  consumePendingPrompt: () => {
    const pending = get().pendingPrompt;
    if (pending !== null) set({ pendingPrompt: null });
    return pending;
  },

  // ==========================================================================
  // 内部回调 — 被 hooks 注册，按 sessionId 路由
  // ==========================================================================

  _onEvent: ({ sessionId, event }) => {
    // done 仅复位流状态，不入消息；先冲掉此前累积的增量，保证不丢内容
    if (event.type === "done") {
      flushPendingEvents();
      set((s) => ({ streamingBySession: { ...s.streamingBySession, [sessionId]: false } }));
      return;
    }

    /*
     * 事件先入缓冲，短窗口内合并成一次 store 更新。
     * 合并规则与原先逐事件处理一致：只要最后一条是 assistant 就并入它，
     * 否则新建一条 assistant 消息（刷新后 store 为空时用这个分支恢复流状态）。
     */
    pendingEvents.push({ sessionId, event });
    if (!pendingFlushTimer) {
      pendingFlushTimer = setTimeout(flushPendingEvents, EVENT_FLUSH_MS);
    }
  },

  _onDone: (data: { sessionId: string }) => {
    // 落库回填前必须先把缓冲里的增量应用完，否则会读到旧状态
    flushPendingEvents();
    set((s) => ({ streamingBySession: { ...s.streamingBySession, [data.sessionId]: false } }));

    /*
     * 正常情况下不再回读整个会话。
     *
     * 主进程与渲染层消费的是同一串事件、同一套 appendEvent 收敛规则，
     * 内存里的结果与落库内容一致。旧实现每轮都 ipc.getSession 重读全量历史
     * 并整体替换数组 —— 全部消息对象都换了引用，转换缓存与 React 渲染全部
     * 失效，长会话在回复结束的瞬间会卡一下。
     *
     * 只有「内存里看不到完整一轮」时（窗口刷新 / 运行中重连 / 首次订阅，
     * 此时桶里只有一条孤立的 assistant 消息）才回读落库结果兜底。
     */
    const memory = get().messagesBySession[data.sessionId] ?? [];
    const last = memory[memory.length - 1];
    const hasUserMessage = memory.some((message) => message.role === "user");
    const complete = last?.role === "assistant" && hasUserMessage;

    if (complete) {
      // 只刷新会话列表（标题/排序更新）
      void get()
        .loadSessions()
        .catch((err) => console.warn("[chat] 会话列表刷新失败", err));
      return;
    }

    void (async () => {
      try {
        const session = await ipc.getSession(data.sessionId);
        // 期间用户可能已经发出下一条消息：此时不能覆盖新运行的实时状态
        if (session && !get().streamingBySession[data.sessionId]) {
          const history = session.messages ?? [];
          /*
           * 回填的是落库后的完整事件流，用量也必须一起重建：
           * 否则刷新 / 重连后仪表会停在 0 或上一轮的旧值，而消息桶已存在，
           * selectSession 不会再为它重算（只有 usage 为空时才会补）。
           */
          const usage = summarizeUsage(history);
          set((s) => ({
            messagesBySession: {
              ...s.messagesBySession,
              [data.sessionId]: history,
            },
            usageBySession: usage
              ? { ...s.usageBySession, [data.sessionId]: usage }
              : s.usageBySession,
          }));
        }
      } catch {
        // 回填失败保留内存中的消息，不影响继续使用
      }
      // 刷新会话列表（标题/排序更新）
      void get()
        .loadSessions()
        .catch((err) => console.warn("[chat] 会话列表刷新失败", err));
    })();
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
 * 否则用当前选中的 Agent。发送目标以此为准。
 */
export function selectEffectiveAgentId(s: ChatState): string {
  if (s.currentSessionId) {
    const session = s.sessions.find((x) => x.id === s.currentSessionId);
    if (session) return session.agentId;
  }
  return s.selectedAgentId;
}
