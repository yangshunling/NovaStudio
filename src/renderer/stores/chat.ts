/**
 * 对话状态管理
 *
 * 并发模型：每个会话有独立的消息桶与流式状态。
 * - messagesBySession / streamingBySession 按 sessionId 分桶
 * - 事件带 sessionId 到达，路由到对应桶（即便该会话不在前台也持续累积）
 * - 切换会话只换 currentSessionId，后台会话继续跑
 * - 同一会话同时只跑一轮；运行中再发送的消息进入 queuedBySession 暂存，
 *   本轮结束后（_onDone）按先来后到自动发送下一条
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
import { toast } from "./toast";
import { appendEvent } from "@shared/agent-events";
import { DEFAULT_PERMISSION_MODE } from "@shared/permission";
import { usePermissionPromptStore } from "./permissionPrompt";
import type { AgentInfo } from "@shared/contracts/agent";
import type {
  AgentEvent,
  InputImage,
  Message,
  Project,
  Session,
} from "@shared/types";

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

/**
 * 暂存区里的一条消息。
 *
 * 运行中用户继续发送时不再被丢弃，而是按顺序排在这里；本轮结束后
 * 自动取出队首发送。中断（停止）后队列会暂停，由用户决定是否继续。
 */
export interface QueuedMessage {
  id: string;
  /** 实际发给 Agent 的完整提示词（可能含 @ 引用说明） */
  prompt: string;
  /** 随消息发送的图片；出队时与原消息一起发送 */
  images?: InputImage[];
  /** 暂存区里展示的正文：只放用户输入，引用说明另起行 */
  display: string;
  createdAt: number;
  /**
   * 入队时选定的回答者。出队时按这个值发送，
   * 避免用户在排队期间切换员工影响已经排好的消息。
   */
  employeeId: string | null;
}

/** 空队列的稳定引用：selector 返回新数组会让 zustand 每帧都认为变了 */
export const EMPTY_QUEUE: readonly QueuedMessage[] = Object.freeze([]);

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
  /** 每个会话是否还有更早的消息未加载（分页游标） */
  hasMoreBySession: Record<string, boolean>;
  /** 每个会话是否正在向前加载更早消息 */
  loadingEarlierBySession: Record<string, boolean>;
  /** 每个会话的 token 用量与上下文占用；随 usage 事件增量更新 */
  usageBySession: Record<string, SessionUsage>;
  /** 每个会话的输入草稿；切走再回来不丢，也不会串到别的会话 */
  draftsBySession: Record<string, string>;
  /** 每个会话是否正在流式运行（供会话列表并发指示、输入区按钮态） */
  streamingBySession: Record<string, boolean>;
  /**
   * 每个会话是否正在「停止中」。
   *
   * abort() 发出后进程可能还要几十毫秒到几秒才收尾；这段时间里不能再启动
   * 新一轮，否则主进程会以「会话正在运行」拒绝。收到 agent:aborted 后复位。
   */
  stoppingBySession: Record<string, boolean>;
  /** 每个会话的暂存区：运行中继续发送的消息按顺序排在这里，本轮结束后自动发送 */
  queuedBySession: Record<string, QueuedMessage[]>;
  /** 正在回放历史的会话 id（供聊天区显示进度条；null 表示空闲） */
  loadingHistoryFor: string | null;
  /** 当前选中的 Agent；空字符串表示尚未确定 */
  selectedAgentId: string;
  /** 新会话要使用的数字员工；null 表示不使用（走全局配置） */
  selectedEmployeeId: string | null;
  /**
   * 新会话草稿的权限模式（settings 命名）。
   *
   * 已开会话直接读写会话记录；这里只服务「还没创建会话」的输入框工具栏，
   * 首条消息创建会话时随 session:create 一起落库。
   */
  selectedPermissionMode: string;
  /**
   * 新会话草稿的模型（完整 ID）；null 表示跟随 Agent 配置的默认模型。
   *
   * 已开会话直接读写会话记录；这里只服务「还没创建会话」的输入框工具栏，
   * 首条消息创建会话时随 session:create 一起落库。
   */
  selectedModel: string | null;
  /**
   * 本次进程内「会话 → 当前回答者」的快照。
   *
   * 值为 null 表示明确选择了默认回答者（通用助手，不绑定数字员工）；
   * 键不存在时才回退到会话记录。用于选择器的乐观更新，
   * 避免主进程写回前界面先闪回旧员工。
   */
  employeeIdBySession: Record<string, string | null>;
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
  /** 向前加载更早的一页消息；返回本次新增条数 */
  loadEarlierMessages: (sessionId: string) => Promise<number>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  /** 置顶 / 取消置顶；只影响列表排序，不参与时间分组 */
  pinSession: (id: string, pinned: boolean) => Promise<void>;

  // Agent
  detectAgents: () => Promise<void>;
  selectAgent: (id: string) => void;

  // 数字员工
  /**
   * 选择下一条消息的回答者；null 表示默认回答者（Agent 全局配置）。
   * 已有会话会同步写回主进程，新会话只更新默认选择。
   */
  selectEmployee: (id: string | null) => Promise<void>;

  /**
   * 切换权限模式。
   * 已开会话写会话记录（下一轮生效）；新会话只更新草稿，首条消息时落库。
   */
  setPermissionMode: (mode: string) => Promise<void>;

  /**
   * 切换会话模型。
   * 已开会话写会话记录（下一轮生效）；新会话只更新草稿。
   * 传 null 恢复「跟随 Agent 默认模型」。
   */
  setModel: (model: string | null) => Promise<void>;

  // 对话
  /**
   * 发送消息。
   * - 会话空闲：立即发送；
   * - 会话运行中：进入该会话的暂存区，本轮结束后自动发送；
   * - `display` 用于暂存区展示（默认与 prompt 相同）。
   * - `images` 随消息一起发送；纯图片消息允许 prompt 为空。
   */
  sendMessage: (
    prompt: string,
    display?: string,
    images?: InputImage[],
  ) => Promise<void>;
  abort: (sessionId?: string) => Promise<void>;
  /** 从暂存区移除一条；默认作用于当前会话 */
  removeQueuedMessage: (id: string, sessionId?: string) => void;
  /** 立即开始消费暂存区（中断后队列处于暂停态）；默认当前会话 */
  resumeQueue: (sessionId?: string) => void;
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
  /** 中断的运行已真正收尾：复位运行态，但不自动消费暂存队列 */
  _onAborted: (data: { sessionId: string }) => void;
}

const EMPTY: readonly Message[] = Object.freeze([]);

/** 会话历史单页条数：与渲染层的首屏预算配合，200 条通常足够覆盖一屏上下文 */
const SESSION_PAGE_SIZE = 200;

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
 * 这里把窗口内到达的事件合并成**一次** store 更新。
 *
 * 文本批次用 48ms（约 20Hz）而不是 16ms：
 * - 可见文本由 AnswerPart 再按 80–200ms 节流，16ms 的 store 更新并不能让
 *   文字更早出现，只会让 assistant-ui 每帧重建一次线程快照、跑一遍
 *   convertMessage 缓存检查；
 * - 结构性事件（工具调用 / 结果 / 错误 / 收敛）立即 flush，不受该窗口影响。
 */
const TEXT_FLUSH_MS = 48;
let pendingEvents: Array<{ sessionId: string; event: AgentEvent }> = [];
let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 每个会话当前这一轮的作答员工。
 *
 * 事件流里不带员工信息，而回答者是在发送时确定的；同一会话同时最多只有
 * 一轮在跑（dispatchPrompt 用 streamingBySession 拦截并发），所以按
 * sessionId 记一份就足够给新建的 assistant 消息打上归属。
 * done / 发送失败时清掉，避免会话切换后残留上一轮的值。
 */
const activeEmployeeBySession = new Map<string, string | null>();

/**
 * 结构性事件：工具调用 / 结果 / 错误 / 整轮收敛。
 * 这类事件数量少、必须及时落到界面，不跟文本一起等 48ms。
 * usage 是纯元数据，归入文本批次即可。
 */
function isStructuralEvent(event: AgentEvent): boolean {
  return (
    event.type !== "text_delta" &&
    event.type !== "thinking_delta" &&
    event.type !== "usage"
  );
}

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

    /*
     * 只有真正变化的切片才换新对象。
     *
     * 每 16ms 无条件复制 streamingBySession / usageBySession 时，订阅整个
     * 切片的地方（会话列表订阅 streamingBySession）会被迫以 60fps 重渲染
     * —— 哪怕流式状态一个字都没变。Zustand 以 Object.is 判断选择器结果，
     * 保持未变切片的引用就是最直接的重渲染屏障。
     */
    const messagesBySession = { ...state.messagesBySession };
    let streamingBySession: Record<string, boolean> | null = null;
    let usageBySession: Record<string, SessionUsage> | null = null;

    for (const [sessionId, events] of bySession) {
      // 用量与消息分开累计：上下文快照只改 contextUsed，
      // 整轮 result 才累加 input/output/cost 与上下文上限。
      let usage = usageBySession?.[sessionId] ?? state.usageBySession[sessionId];
      let usageChanged = false;
      for (const event of events) {
        if (event.type !== "usage") continue;
        usage = applyUsage(usage, event);
        usageChanged = true;
      }
      if (usageChanged && usage) {
        if (!usageBySession) usageBySession = { ...state.usageBySession };
        usageBySession[sessionId] = usage;
      }

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
        {
          id: newId(),
          role: "assistant",
          content,
          timestamp: Date.now(),
          employeeId: activeEmployeeBySession.get(sessionId) ?? null,
        },
      ];
      // 未知会话收到事件（例如运行中刷新）：恢复“正在执行”状态
      if (!streamingBySession) {
        streamingBySession = { ...state.streamingBySession };
      }
      streamingBySession[sessionId] = true;
    }

    return {
      messagesBySession,
      ...(streamingBySession ? { streamingBySession } : {}),
      ...(usageBySession ? { usageBySession } : {}),
    };
  });
}

// ============================================================================
// 暂存区（同一会话的运行中排队）
// ============================================================================

/**
 * 真正把一条消息发给某个会话。
 *
 * 调用方保证该会话当前空闲。运行标记在第一个 await 之前同步写入，
 * 因此多次调用不会并发启动同一会话。
 */
async function dispatchPrompt(
  sessionId: string,
  prompt: string,
  employeeId: string | null,
  images?: InputImage[],
): Promise<void> {
  if (useChatStore.getState().streamingBySession[sessionId]) return;

  const userMsg: Message = {
    id: newId(),
    role: "user",
    content: [
      ...(images ?? []).map(
        (image): AgentEvent => ({
          type: "image",
          mediaType: image.mediaType,
          data: image.data,
        }),
      ),
      ...(prompt ? [{ type: "text" as const, content: prompt }] : []),
    ],
    timestamp: Date.now(),
  };
  useChatStore.setState((s) => ({
    messagesBySession: {
      ...s.messagesBySession,
      [sessionId]: [...(s.messagesBySession[sessionId] ?? []), userMsg],
    },
    streamingBySession: { ...s.streamingBySession, [sessionId]: true },
    stoppingBySession: { ...s.stoppingBySession, [sessionId]: false },
  }));

  // 本轮回答者：事件流回来时据此给新建的 assistant 消息打归属
  activeEmployeeBySession.set(sessionId, employeeId);

  try {
    // 回答者随消息一起传入：队列里的消息始终用入队时选定的员工
    const result = await ipc.sendAgent(sessionId, prompt, employeeId, images);
    if (!result.ok) throw new Error(result.error);
    if (result.canceled) {
      /*
       * 用户在准备阶段点了停止：主进程没有落用户消息、也没有拉起进程。
       * 移除这里的乐观消息并复位流式状态；不写错误气泡，队列保持暂停。
       */
      activeEmployeeBySession.delete(sessionId);
      useChatStore.setState((s) => ({
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: (s.messagesBySession[sessionId] ?? []).filter(
            (message) => message.id !== userMsg.id,
          ),
        },
        streamingBySession: { ...s.streamingBySession, [sessionId]: false },
        stoppingBySession: { ...s.stoppingBySession, [sessionId]: false },
      }));
      return;
    }
    // done 事件会复位 streaming；此处不提前复位，避免中间闪烁
  } catch (err) {
    // 发送失败：写进消息流，并让暂存区保持暂停，
    // 剩余消息等用户确认后再继续，避免连续失败刷屏。
    activeEmployeeBySession.delete(sessionId);
    useChatStore.setState((s) => ({
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
            employeeId,
          },
        ],
      },
    }));
  }
}

/**
 * 消费暂存区：取队首发送。
 * 运行中或队列为空时什么都不做；队列可能在 done 回调、发送动作、
 * 「继续发送」按钮三处被触发，这里统一收口，保证同一会话不会并发。
 */
function drainQueue(sessionId: string): void {
  const state = useChatStore.getState();
  if (state.streamingBySession[sessionId]) return;

  const head = state.queuedBySession[sessionId]?.[0];
  if (!head) return;

  useChatStore.setState((s) => {
    const remaining = (s.queuedBySession[sessionId] ?? []).filter(
      (item) => item.id !== head.id,
    );
    const queuedBySession = { ...s.queuedBySession };
    if (remaining.length > 0) queuedBySession[sessionId] = remaining;
    else delete queuedBySession[sessionId];
    return { queuedBySession };
  });

  void dispatchPrompt(sessionId, head.prompt, head.employeeId, head.images);
}

export const useChatStore = create<ChatState>((set, get) => ({
  agents: [],
  projects: [],
  sessions: [],
  currentProjectId: null,
  currentSessionId: null,
  messagesBySession: {},
  hasMoreBySession: {},
  loadingEarlierBySession: {},
  usageBySession: {},
  draftsBySession: {},
  streamingBySession: {},
  stoppingBySession: {},
  queuedBySession: {},
  loadingHistoryFor: null,
  selectedAgentId: "",
  selectedEmployeeId: null,
  selectedPermissionMode: DEFAULT_PERMISSION_MODE,
  selectedModel: null,
  employeeIdBySession: {},
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
    try {
      const projects = await ipc.listProjects();
      set({ projects, projectsLoaded: true });
    } catch (err) {
      // 失败也要结束加载态，否则页面会永远停在骨架屏
      set({ projectsLoaded: true });
      throw err;
    }
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
      const stoppingBySession = { ...state.stoppingBySession };
      const usageBySession = { ...state.usageBySession };
      const hasMoreBySession = { ...state.hasMoreBySession };
      const loadingEarlierBySession = { ...state.loadingEarlierBySession };
      const draftsBySession = { ...state.draftsBySession };
      const queuedBySession = { ...state.queuedBySession };
      const employeeIdBySession = { ...state.employeeIdBySession };
      for (const sessionId of removed) {
        delete messagesBySession[sessionId];
        delete streamingBySession[sessionId];
        delete stoppingBySession[sessionId];
        delete usageBySession[sessionId];
        delete hasMoreBySession[sessionId];
        delete loadingEarlierBySession[sessionId];
        delete draftsBySession[sessionId];
        delete queuedBySession[sessionId];
        delete employeeIdBySession[sessionId];
        usePermissionPromptStore.getState().clearSession(sessionId);
      }
      return {
        projects: state.projects.filter((p) => p.id !== id),
        sessions: state.sessions.filter((s) => s.projectId !== id),
        messagesBySession,
        streamingBySession,
        stoppingBySession,
        usageBySession,
        hasMoreBySession,
        loadingEarlierBySession,
        draftsBySession,
        queuedBySession,
        employeeIdBySession,
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

    const result = await ipc.setSessionProject(sessionId, projectId);
    if (!result) throw new Error("会话不存在");
    const { session, marker } = result;

    /*
     * 暂存队列绑定的是「旧工作区」里的任务。
     *
     * 主进程只在会话已有上下文时写分隔提示（marker），但队列与上下文无关：
     * 中断后暂停的队列 + 换到一个没有上下文的新工作区时 marker 为空，
     * 旧队列会留着，恢复发送就在新 cwd 下跑旧任务，可能写错文件。
     * 所以只要 projectId 真的变了，队列一律作废。
     */
    const current = get();
    const projectChanged = current.currentProjectId !== session.projectId;
    const clearedQueueCount = projectChanged
      ? (current.queuedBySession[sessionId] ?? []).length
      : 0;

    set((s) => {
      const next: Partial<ChatState> = {
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
      };

      if (marker) {
        /*
         * 主进程已经落库分隔提示；这里补进当前会话的消息桶，
         * 并把旧上下文相关的用量与暂存区一起清掉。
         */
        next.messagesBySession = {
          ...s.messagesBySession,
          [sessionId]: [
            ...(s.messagesBySession[sessionId] ?? []),
            marker,
          ],
        };
        const usage = { ...s.usageBySession };
        delete usage[sessionId];
        next.usageBySession = usage;
      }

      // 队列在「有分隔提示」或「工作区真的换了」时都要清（见上）
      if ((marker || projectChanged) && s.queuedBySession[sessionId]) {
        const queued = { ...s.queuedBySession };
        delete queued[sessionId];
        next.queuedBySession = queued;
      }

      return next;
    });

    if (clearedQueueCount > 0) {
      toast.info("工作区已切换，暂存消息已清空", 4000);
    }
  },

  newSession: () => {
    // 只清空当前视图，不预建会话；首条消息时才 createSession，
    // 避免产生大量空会话。新会话默认不绑定项目。
    // 显式「新建」意味着放弃上一份未发送草稿，避免下次进来又看到旧内容。
    set((state) => {
      /*
       * 每次新建会话都回到默认回答者「通用助手」：员工是按任务派的，
       * 沿用上一次的选择容易让人以为新任务仍然带着旧人设。
       * 模型同理回到「跟随 Agent 默认」，避免上一个任务的临时选择
       * 被无声地带到不相关的任务里。
       */
      const cleared = {
        currentSessionId: null,
        currentProjectId: null,
        selectedEmployeeId: null,
        selectedModel: null,
      };
      if (!(NEW_SESSION_DRAFT_KEY in state.draftsBySession)) {
        return cleared;
      }
      const draftsBySession = { ...state.draftsBySession };
      delete draftsBySession[NEW_SESSION_DRAFT_KEY];
      return {
        ...cleared,
        draftsBySession,
      };
    });
  },

  pickDirectory: () => ipc.pickDirectory(),

  // ==========================================================================
  // 会话
  // ==========================================================================

  loadSessions: async () => {
    try {
      const sessions = await ipc.listSessions();
      set({ sessions, sessionsLoaded: true });
    } catch (err) {
      // 失败也要结束加载态，否则会话列表会永远停在骨架屏
      set({ sessionsLoaded: true });
      throw err;
    }
  },

  selectSession: async (id) => {
    // 点会话时立刻同步该项目绑定态，不等历史回放 —— 否则冷切换期间
    // 输入框旁的项目标签仍是上一个会话的，看起来"没联动"。
    // projectId 从 store 里已持有的 sessions 查，不必等 ipc.getSession。
    const known = get().sessions.find((s) => s.id === id);
    if (known) {
      set((s) => {
        // 以会话记录为准回填员工快照（null 也要写入，避免回退到过期的会话列表）
        const employeeIdBySession = { ...s.employeeIdBySession };
        employeeIdBySession[id] = known.employeeId ?? null;
        return {
          currentSessionId: id,
          currentProjectId: known.projectId,
          employeeIdBySession,
        };
      });
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
      const session = await ipc.getSession(id, { limit: SESSION_PAGE_SIZE });
      set((s) => {
        const history = session?.messages ?? [];
        const existing = s.messagesBySession[id];
        // 回放期间用户可能已经发出了消息：保留这些新消息，避免被历史覆盖
        // 用 Set 查重：回放期间新发出的消息很少，但历史可能有上千条，
        // 逐条 some() 是 O(历史 × 新消息)，长会话下会拖慢切换。
        const historyIds = new Set(history.map((message) => message.id));
        const merged = existing
          ? [...history, ...existing.filter((message) => !historyIds.has(message.id))]
          : history;
        const usage = summarizeUsage(merged);
        return {
          messagesBySession: { ...s.messagesBySession, [id]: merged },
          hasMoreBySession: {
            ...s.hasMoreBySession,
            [id]: session?.hasMoreMessages ?? false,
          },
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

  loadEarlierMessages: async (sessionId) => {
    if (get().loadingEarlierBySession[sessionId]) return 0;
    const list = get().messagesBySession[sessionId] ?? [];
    const oldest = list[0];
    if (!oldest) return 0;

    set((s) => ({
      loadingEarlierBySession: {
        ...s.loadingEarlierBySession,
        [sessionId]: true,
      },
    }));
    try {
      const session = await ipc.getSession(sessionId, {
        limit: SESSION_PAGE_SIZE,
        before: oldest.timestamp,
        beforeId: oldest.id,
      });
      const older = session?.messages ?? [];
      const existingIds = new Set(list.map((message) => message.id));
      const merged = [
        ...older.filter((message) => !existingIds.has(message.id)),
        ...list,
      ];
      const added = merged.length - list.length;
      const usage = summarizeUsage(merged);
      set((s) => ({
        messagesBySession: { ...s.messagesBySession, [sessionId]: merged },
        hasMoreBySession: {
          ...s.hasMoreBySession,
          [sessionId]: session?.hasMoreMessages ?? false,
        },
        ...(usage
          ? { usageBySession: { ...s.usageBySession, [sessionId]: usage } }
          : {}),
      }));
      return added;
    } finally {
      set((s) => ({
        loadingEarlierBySession: {
          ...s.loadingEarlierBySession,
          [sessionId]: false,
        },
      }));
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
    usePermissionPromptStore.getState().clearSession(id);
    set((s) => {
      const messagesBySession = { ...s.messagesBySession };
      delete messagesBySession[id];
      const streamingBySession = { ...s.streamingBySession };
      delete streamingBySession[id];
      const stoppingBySession = { ...s.stoppingBySession };
      delete stoppingBySession[id];
      const usageBySession = { ...s.usageBySession };
      delete usageBySession[id];
      const hasMoreBySession = { ...s.hasMoreBySession };
      delete hasMoreBySession[id];
      const loadingEarlierBySession = { ...s.loadingEarlierBySession };
      delete loadingEarlierBySession[id];
      const draftsBySession = { ...s.draftsBySession };
      delete draftsBySession[id];
      const queuedBySession = { ...s.queuedBySession };
      delete queuedBySession[id];
      const employeeIdBySession = { ...s.employeeIdBySession };
      delete employeeIdBySession[id];
      const wasCurrent = s.currentSessionId === id;
      // 删除当前会话后输入区回到「新会话」态：不要翻出更早遗留的新会话草稿
      if (wasCurrent) delete draftsBySession[NEW_SESSION_DRAFT_KEY];
      return {
        sessions: s.sessions.filter((se) => se.id !== id),
        messagesBySession,
        streamingBySession,
        stoppingBySession,
        usageBySession,
        hasMoreBySession,
        loadingEarlierBySession,
        draftsBySession,
        queuedBySession,
        employeeIdBySession,
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

  selectEmployee: async (id) => {
    const { currentSessionId, employeeIdBySession } = get();

    // 新会话：只更新默认选择，首条消息创建会话时再落库
    if (!currentSessionId) {
      set({ selectedEmployeeId: id });
      return;
    }

    // 记录乐观更新前的快照状态，失败时精确回滚
    const hadSnapshot = currentSessionId in employeeIdBySession;
    const previousSnapshot = employeeIdBySession[currentSessionId] ?? null;

    /*
     * 乐观更新：选择器和下一条消息立即使用新员工（null 也要写入，
     * 表示明确选择默认回答者，而不是回退到会话列表里的旧值）。
     */
    set((s) => ({
      employeeIdBySession: {
        ...s.employeeIdBySession,
        [currentSessionId]: id,
      },
    }));

    try {
      const session = await ipc.setSessionEmployee(currentSessionId, id);
      if (!session) throw new Error("会话不存在");
      set((s) => ({
        sessions: s.sessions.map((item) =>
          item.id === session.id
            ? { ...item, employeeId: session.employeeId ?? null }
            : item,
        ),
      }));
    } catch (err) {
      set((s) => {
        const next = { ...s.employeeIdBySession };
        if (hadSnapshot) next[currentSessionId] = previousSnapshot;
        else delete next[currentSessionId];
        return { employeeIdBySession: next };
      });
      throw err;
    }
  },

  setPermissionMode: async (mode) => {
    const { currentSessionId } = get();

    // 新会话：只更新草稿，首条消息创建会话时随 session:create 落库
    if (!currentSessionId) {
      set({ selectedPermissionMode: mode });
      return;
    }

    /*
     * 乐观更新选择器，同时把草稿同步成当前选择：
     * 下一次新建会话沿用「上一次用过的档位」，而不是永远回到 Agent 默认值。
     */
    set((s) => ({
      selectedPermissionMode: mode,
      sessions: s.sessions.map((item) =>
        item.id === currentSessionId ? { ...item, permissionMode: mode } : item,
      ),
    }));
    try {
      const session = await ipc.setSessionPermissionMode(
        currentSessionId,
        mode,
      );
      if (!session) throw new Error("会话不存在");
      set((s) => ({
        sessions: s.sessions.map((item) =>
          item.id === session.id
            ? { ...item, permissionMode: session.permissionMode ?? mode }
            : item,
        ),
      }));
    } catch (err) {
      // 失败时用主进程返回的旧值回滚；拿不到就重新拉一次列表
      try {
        await get().loadSessions();
      } catch {
        // 忽略：下一次打开会话列表时会再同步
      }
      throw err;
    }
  },

  setModel: async (model) => {
    const value = model?.trim() || null;
    const { currentSessionId } = get();

    // 新会话：只更新草稿，首条消息创建会话时随 session:create 落库
    if (!currentSessionId) {
      set({ selectedModel: value });
      return;
    }

    // 乐观更新，避免等主进程写库期间下拉又跳回旧值
    set((s) => ({
      selectedModel: value,
      sessions: s.sessions.map((item) =>
        item.id === currentSessionId ? { ...item, model: value } : item,
      ),
    }));
    try {
      const session = await ipc.setSessionModel(currentSessionId, value);
      if (!session) throw new Error("会话不存在");
      set((s) => ({
        sessions: s.sessions.map((item) =>
          item.id === session.id
            ? { ...item, model: session.model ?? value }
            : item,
        ),
      }));
    } catch (err) {
      try {
        await get().loadSessions();
      } catch {
        // 忽略：下一次打开会话列表时会再同步
      }
      throw err;
    }
  },

  // ==========================================================================
  // 对话
  // ==========================================================================

  sendMessage: async (prompt, display, images) => {
    const state = get();
    const currentId = state.currentSessionId;
    const label = display ?? prompt;

    if (currentId) {
      /*
       * 当前回答者：优先用选择器的乐观快照，其次用会话记录。
       * 这条消息从入队到真正发送都锁定这个值，避免中途换人串台。
       */
      const employeeId =
        currentId in state.employeeIdBySession
          ? state.employeeIdBySession[currentId]
          : (state.sessions.find((session) => session.id === currentId)
              ?.employeeId ?? null);

      /*
       * 运行中不再丢弃消息：主进程同一会话只允许一个运行句柄，
       * 但用户完全可以在等待期间继续提问。这里把消息放进暂存区，
       * 本轮结束后由 _onDone 按先来后到自动发送。
       *
       * 队列已有内容时也排队（即使当前空闲）：中断后队列会暂停，
       * 此时新消息应排在旧消息之后，避免打乱用户预期的顺序。
       */
      const queue = state.queuedBySession[currentId] ?? [];
      if (
        state.streamingBySession[currentId] ||
        state.stoppingBySession[currentId] ||
        queue.length > 0
      ) {
        set((s) => ({
          queuedBySession: {
            ...s.queuedBySession,
            [currentId]: [
              ...(s.queuedBySession[currentId] ?? []),
              {
                id: newId(),
                prompt,
                images,
                display: label,
                createdAt: Date.now(),
                employeeId,
              },
            ],
          },
        }));
        // 空闲说明队列之前被暂停了（中断 / 发送失败）：立刻恢复消费
        drainQueue(currentId);
        return;
      }

      await dispatchPrompt(currentId, prompt, employeeId, images);
      return;
    }

    // 无会话 → 预创建一个，拿到 sessionId 再发（保证事件可路由）
    // Agent 由「当前选中 → 第一个已安装」推导，不硬编码任何具体 Agent
    const picked =
      state.selectedAgentId ||
      state.agents.find((a) => a.status.installed)?.id;
    // 抛给调用方：此时还没有会话，无法把错误写进消息流
    if (!picked) throw new Error("未检测到可用的 Agent，请先完成安装或在 Agent 配置中选择");

    // 项目可空：未绑定时主进程会回退到默认目录；员工随会话一起落库
    const employeeId = state.selectedEmployeeId;
    const session = await ipc.createSession(
      state.currentProjectId,
      picked,
      employeeId,
      state.selectedPermissionMode,
      state.selectedModel,
    );
    const sessionId = session.id;
    // 主进程已持久化 employeeId；这里同步一份，保证列表刷新前也能正确显示
    set((s) => ({
      currentSessionId: sessionId,
      currentProjectId: session.projectId,
      messagesBySession: { ...s.messagesBySession, [sessionId]: [] },
      streamingBySession: { ...s.streamingBySession, [sessionId]: false },
      employeeIdBySession: {
        ...s.employeeIdBySession,
        [sessionId]: employeeId ?? null,
      },
    }));
    // 立即刷新会话列表，让新会话出现（不等跑完）
    void get()
      .loadSessions()
      .catch((err) => console.warn("[chat] 会话列表刷新失败", err));

    await dispatchPrompt(sessionId, prompt, employeeId, images);
  },

  abort: async (sessionId) => {
    const id = sessionId ?? get().currentSessionId;
    if (!id) return;

    /*
     * 先进入 stopping，等主进程把进程真正收尾（agent:aborted）后再回 idle。
     * 如果直接置 streaming=false，用户马上发下一条会撞上仍在写库的上一轮，
     * 主进程只能以「会话正在运行」拒绝。
     */
    set((s) => ({
      stoppingBySession: { ...s.stoppingBySession, [id]: true },
    }));

    try {
      const aborted = await ipc.abortAgent(id);
      if (!aborted) {
        // 没有命中运行中的会话（可能刚好自然结束）：立即恢复可发送状态
        set((s) => ({
          streamingBySession: { ...s.streamingBySession, [id]: false },
          stoppingBySession: { ...s.stoppingBySession, [id]: false },
        }));
      }
    } catch (err) {
      set((s) => ({
        stoppingBySession: { ...s.stoppingBySession, [id]: false },
      }));
      throw err;
    }

    // 暂存区保持不动、且不自动开跑：用户点「停止」是明确的刹车，
    // 不应该马上又启动下一条。队列由输入区的「继续发送」恢复。
  },

  removeQueuedMessage: (id, sessionId) => {
    const sid = sessionId ?? get().currentSessionId;
    if (!sid) return;
    set((s) => {
      const list = s.queuedBySession[sid];
      if (!list) return s;
      const remaining = list.filter((item) => item.id !== id);
      const queuedBySession = { ...s.queuedBySession };
      if (remaining.length > 0) queuedBySession[sid] = remaining;
      else delete queuedBySession[sid];
      return { queuedBySession };
    });
  },

  resumeQueue: (sessionId) => {
    const sid = sessionId ?? get().currentSessionId;
    if (sid) drainQueue(sid);
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
      activeEmployeeBySession.delete(sessionId);
      set((s) => ({
        streamingBySession: { ...s.streamingBySession, [sessionId]: false },
        stoppingBySession: { ...s.stoppingBySession, [sessionId]: false },
      }));
      drainQueue(sessionId);
      return;
    }

    /*
     * 事件先入缓冲，短窗口内合并成一次 store 更新。
     * 合并规则与原先逐事件处理一致：只要最后一条是 assistant 就并入它，
     * 否则新建一条 assistant 消息（刷新后 store 为空时用这个分支恢复流状态）。
     */
    pendingEvents.push({ sessionId, event });
    // 工具/错误/收敛事件立刻落地；文本与 usage 合并到 48ms 窗口
    if (isStructuralEvent(event)) {
      flushPendingEvents();
      return;
    }
    if (!pendingFlushTimer) {
      pendingFlushTimer = setTimeout(flushPendingEvents, TEXT_FLUSH_MS);
    }
  },

  _onDone: (data: { sessionId: string }) => {
    // 落库回填前必须先把缓冲里的增量应用完，否则会读到旧状态
    flushPendingEvents();
    // 主进程应先推 resolved；这里兜底，避免丢推送时弹窗残留
    usePermissionPromptStore.getState().clearSession(data.sessionId);
    activeEmployeeBySession.delete(data.sessionId);
    set((s) => ({
      streamingBySession: { ...s.streamingBySession, [data.sessionId]: false },
      stoppingBySession: { ...s.stoppingBySession, [data.sessionId]: false },
    }));

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
      // 本轮收尾后继续消费暂存区（运行中的消息在这里接力）
      drainQueue(data.sessionId);
      return;
    }

    void (async () => {
      try {
        const session = await ipc.getSession(data.sessionId, {
          limit: SESSION_PAGE_SIZE,
        });
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
            hasMoreBySession: {
              ...s.hasMoreBySession,
              [data.sessionId]: session.hasMoreMessages ?? false,
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
    })().finally(() => {
      /*
       * 回填完成后再消费暂存区：这样下一条的用户消息追加在「已回填的历史」
       * 之后，而不是被回填结果覆盖。回填函数自身也会在检测到新运行
       * （streaming 已置位）时跳过覆盖。
       */
      drainQueue(data.sessionId);
    });
  },

  _onAborted: (data: { sessionId: string }) => {
    /*
     * 用户中断的运行已经真正收尾（进程退出 + 消息落库完成）。
     * 只复位运行态，不消费暂存队列：点「停止」是明确的刹车，
     * 队列要等用户点「继续发送」才恢复。
     */
    flushPendingEvents();
    usePermissionPromptStore.getState().clearSession(data.sessionId);
    activeEmployeeBySession.delete(data.sessionId);
    set((s) => ({
      streamingBySession: { ...s.streamingBySession, [data.sessionId]: false },
      stoppingBySession: { ...s.stoppingBySession, [data.sessionId]: false },
    }));
    void get()
      .loadSessions()
      .catch((err) => console.warn("[chat] 会话列表刷新失败", err));
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

/**
 * 选择器：当前会话绑定的数字员工 id。
 *
 * 与 EmployeeSelector 的口径一致：先读本次进程内的快照（乐观更新），
 * 再回退到会话记录。只作为消息没带员工信息时的兜底（旧数据 / CLI 回放）。
 */
export function selectEffectiveEmployeeId(s: ChatState): string | null {
  const sessionId = s.currentSessionId;
  if (!sessionId) return s.selectedEmployeeId;
  if (sessionId in s.employeeIdBySession) {
    return s.employeeIdBySession[sessionId] ?? null;
  }
  return s.sessions.find((x) => x.id === sessionId)?.employeeId ?? null;
}
