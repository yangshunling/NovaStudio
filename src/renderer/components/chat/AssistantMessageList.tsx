/**
 * assistant-ui 消息列表适配层
 *
 * Nova 继续持有 AgentEvent / Zustand / SQLite；本组件只把领域事件转换成
 * assistant-ui 的 ThreadMessageLike，并使用其 Thread / Message / Part 原语渲染。
 * 视觉样式全部走 Nova 的语义 token，因此昼夜皮肤自动兼容。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  useMessagePartImage,
  useMessagePartReasoning,
  useMessagePartText,
  type DataMessagePartProps,
  type ThreadMessageLike,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  Bug,
  Check,
  ChevronRight,
  Copy,
  FileText,
  FolderTree,
  ListChecks,
  RotateCcw,
  AlertTriangle,
} from "lucide-react";
import type {
  AgentEvent,
  DisplayReference,
  Message,
  ReferenceKind,
  ToolKind,
  ToolResultImage,
} from "@shared/types";
import { clamp } from "@shared/math";
import { TOOL_TARGET_KEYS, readStringField } from "@shared/tool-input";
import {
  selectCurrentMessages,
  selectEffectiveAgentId,
  selectEffectiveEmployeeId,
  useChatStore,
} from "../../stores/chat";
import { useEmployeesStore } from "../../stores/employees";
import { REVEAL_MESSAGE_EVENT } from "../../lib/chat-events";
import { formatJson, toMessage } from "../../lib/utils";
import { imageSrc } from "../../lib/attachment";
import logoAvatarUrl from "../../assets/logo-avatar.png";
import { copyText } from "../../lib/clipboard";
import { toast } from "../../stores/toast";
import { CHAT_VIEWPORT_ID, scrollToMessage } from "../../lib/chat-scroll";
import { StreamingMarkdown } from "../ui/MarkdownRenderer";
import {
  AgentAvatar,
  EmployeeChatAvatar,
  NovaAvatar,
} from "../ui/MessageAvatar";
import { UserBubble } from "../ui/UserBubble";
import { extractFileChanges } from "../../lib/tool-diff";
import { markdownInterval, useThrottledValue } from "../../hooks/useThrottledValue";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingCard } from "./ThinkingCard";
import { ReferenceBlock } from "./ReferenceBlock";

/** 欢迎卡上的示例：点击后填入输入框，由用户决定是否发送 */
const SUGGESTIONS = [
  {
    icon: FolderTree,
    label: "了解当前工作区",
    prompt: "先浏览一下当前工作区，介绍一下项目结构和主要模块。",
  },
  {
    icon: ListChecks,
    label: "拆解一个需求",
    prompt: "我有个需求，帮我拆解成可执行的开发任务。",
  },
  {
    icon: FileText,
    label: "写一份周报",
    prompt: "根据我最近的工作，帮我写一份本周周报。",
  },
  {
    icon: Bug,
    label: "排查一个问题",
    prompt: "帮我排查一个问题，先问我几个关键信息。",
  },
];

/**
 * 消息窗口按「渲染成本」而不是条数来定。
 *
 * 只限制条数并不能限制成本：实测本地库中最长的会话有 40 条消息、
 * 正文合计 143 万字符，其中单条就有 32 万字符。按条数挂载 120 条时，
 * 打开会话会把全部正文一次性交给 Markdown 解析（约 1.6ms/KB），
 * 直接卡住一两秒。这里同时限制正文长度与事件数：
 * - 正文按字符计；
 * - 每个事件（工具调用 / 结果）折算固定权重，避免几百张工具卡片撑爆 DOM。
 */
const INITIAL_TEXT_BUDGET = 120_000;
const LOAD_EARLIER_BUDGET = 80_000;
/** 单次最多展开多少条（防止大量短消息一次挂太多） */
const LOAD_EARLIER_STEP = 40;
/** 首次最多挂载多少条 */
const INITIAL_MESSAGE_WINDOW = 120;
/** 单个事件折算的正文权重 */
const EVENT_WEIGHT = 120;

/** 模块级空实现：保持 assistant-ui store 对象的引用稳定 */
const NOOP_ON_NEW = async (): Promise<void> => {};

/** 估算一条消息的渲染成本 */
function messageWeight(message: Message): number {
  let chars = 0;
  for (const event of message.content) {
    if (event.type === "text" || event.type === "thinking") {
      chars += event.content.length;
    }
  }
  return chars + message.content.length * EVENT_WEIGHT;
}

/**
 * 最近的窗口起点：从末尾往前累加，直到超出预算。
 * 最后一条消息无论多大都要包含，否则打开会话会是一片空白。
 */
function windowStartFor(messages: readonly Message[]): number {
  let weight = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const next = messageWeight(messages[i]);
    if (
      count > 0 &&
      (count >= INITIAL_MESSAGE_WINDOW || weight + next > INITIAL_TEXT_BUDGET)
    ) {
      break;
    }
    weight += next;
    count += 1;
  }
  return Math.max(0, messages.length - count);
}

/** 「载入更早」：从当前窗口继续往前，直到用完本次预算 */
function earlierStartFor(messages: readonly Message[], start: number): number {
  let weight = 0;
  let count = 0;
  let index = start - 1;
  for (; index >= 0; index -= 1) {
    const next = messageWeight(messages[index]);
    if (
      count > 0 &&
      (count >= LOAD_EARLIER_STEP || weight + next > LOAD_EARLIER_BUDGET)
    ) {
      break;
    }
    weight += next;
    count += 1;
  }
  return Math.max(0, index + 1);
}

/**
 * 消息 part 渲染表。
 *
 * 必须放在模块作用域：`MessagePrimitive.Parts` 用引用比较 components，
 * 内联对象每次渲染都会换引用，流式期间整条消息的 part 分发会被反复击穿。
 */
const ASSISTANT_PART_COMPONENTS = {
  Text: AnswerPart,
  Reasoning: ReasoningPart,
  data: {
    by_name: {
      novaError: ErrorPart,
      novaWarning: WarningPart,
    },
  },
  tools: { Fallback: ToolPart },
};

/** system 消息只有纯文本，保持引用稳定以命中 assistant-ui 的 components 缓存 */
const SYSTEM_PART_COMPONENTS = { Text: SystemTextPart };

/** 用户消息的 part 表：正文 + 随消息发送的图片 */
const USER_PART_COMPONENTS = {
  Text: UserTextPart,
  Image: UserImagePart,
  data: {
    by_name: {
      novaReference: UserReferencePart,
    },
  },
};

/**
 * ThreadPrimitive.Messages 的组件表同样必须保持引用稳定。
 * 内联对象会让 assistant-ui 在每次渲染时认为消息级组件变了，
 * 从而跳过它对单条消息的缓存。
 */
const THREAD_MESSAGE_COMPONENTS = {
  UserMessage,
  AssistantMessage,
  SystemMessage,
};

export function AssistantMessageList({
  onSuggestion,
}: {
  onSuggestion?: (text: string) => void;
} = {}) {
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const messages = useChatStore(selectCurrentMessages);
  const streaming = useChatStore(
    (s) => !!s.streamingBySession[s.currentSessionId ?? ""],
  );

  /*
   * 回复头像要解析数字员工档案（头像 / 名称）。
   * 聊天页不一定进过员工页，这里兜底拉一次；store 内部已做过加载去重。
   */
  const loadEmployees = useEmployeesStore((s) => s.load);
  useEffect(() => {
    void loadEmployees();
  }, [loadEmployees]);

  /*
   * 窗口化：只把最近一段消息交给 assistant-ui。
   *
   * 长会话下真正昂贵的是「转换 + 渲染所有历史消息」，仅靠 CSS 跳过绘制
   * 并不能省掉 React/Markdown 的成本。这里默认只挂载最近 120 条，顶部
   * 提供「载入更早」，既保留可回看能力，又让打开长会话的成本与长度无关。
   *
   * 窗口必须和会话一起保存：切换会话时，如果沿用上一个会话的 windowStart，
   * 首帧就可能把新会话的整段历史挂载出来（例如从 10 条会话切到 1000 条，
   * windowStart=0 会先渲染 1000 条，等 effect 再改回最近 120 条）。
   * 那一帧的 Markdown 解析 / 布局就是切换时「卡一下」的来源。
   */
  const [messageWindow, setMessageWindow] = useState<{
    sessionId: string | null;
    start: number;
  }>(() => ({
    sessionId: currentSessionId,
    start: windowStartFor(messages),
  }));
  /** 载入更早前的高度，用于抵消前插造成的滚动跳变 */
  const prependHeightRef = useRef<number | null>(null);
  /** 远程分页前插后强制触发一次高度校正（start 可能本来就是 0） */
  const [prependVersion, setPrependVersion] = useState(0);
  /** 需要展开窗口后滚动到的消息 id（问题导航点击未挂载消息时） */
  const revealIdRef = useRef<string | null>(null);

  const total = messages.length;
  /*
   * 当前会话的默认窗口起点。
   * 依赖只取长度：流式期间数组每 16ms 换一次引用，但长度不变，切窗成本
   * 没必要跟着每个 token 重算；历史整体替换时长度一定会变。
   */
  const defaultStart = useMemo(
    () => windowStartFor(messages),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentSessionId, messages.length],
  );
  // 第一帧就用「当前会话」的窗口，而不是上一个会话遗留的 start
  const baseStart =
    messageWindow.sessionId === currentSessionId
      ? messageWindow.start
      : defaultStart;
  const start = clamp(baseStart, 0, Math.max(0, total - 1));
  const hasMore = useChatStore((s) =>
    s.currentSessionId ? !!s.hasMoreBySession[s.currentSessionId] : false,
  );
  const loadingEarlier = useChatStore((s) =>
    s.currentSessionId
      ? !!s.loadingEarlierBySession[s.currentSessionId]
      : false,
  );
  const loadEarlierMessages = useChatStore((s) => s.loadEarlierMessages);
  const visibleMessages = useMemo(
    () => messages.slice(start),
    [messages, start],
  );
  const messageCount = visibleMessages.length;

  /** 在保留当前窗口偏移的前提下更新窗口，并把窗口归属到当前会话 */
  const setWindowStart = useCallback(
    (updater: (baseStart: number) => number) => {
      setMessageWindow((current) => {
        const base =
          current.sessionId === currentSessionId
            ? current.start
            : windowStartFor(messages);
        return {
          sessionId: currentSessionId,
          start: Math.max(0, updater(base)),
        };
      });
    },
    [currentSessionId, messages.length],
  );

  // 问题导航请求查看一条可能尚未挂载的消息
  const revealStateRef = useRef({
    sessionId: currentSessionId,
    messages,
    start,
  });
  revealStateRef.current = { sessionId: currentSessionId, messages, start };
  useEffect(() => {
    const onReveal = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) return;

      const current = revealStateRef.current;
      const index = current.messages.findIndex((message) => message.id === id);
      if (index < 0) return;

      if (index >= current.start) {
        // 会话刚切换 / 历史刚到达时，DOM 可能还差一两帧，重试而不是直接放弃
        let attempts = 0;
        const attempt = () => {
          if (scrollToMessage(id)) return;
          if (attempts++ < 5) requestAnimationFrame(attempt);
        };
        requestAnimationFrame(attempt);
        return;
      }

      // 目标在窗口之前：向前扩到目标附近，渲染完成后再滚动。
      // 这里直接给绝对起点，不能走「相对当前窗口」的 updater：
      // 事件监听只注册一次，闭包里的 base 可能属于上一个会话。
      revealIdRef.current = id;
      setMessageWindow({
        sessionId: current.sessionId,
        start: Math.max(0, index - 5),
      });
    };

    window.addEventListener(REVEAL_MESSAGE_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_MESSAGE_EVENT, onReveal);
  }, []);

  // 展开后滚动到目标消息。DOM 可能晚一两帧才提交（assistant-ui 再渲染），
  // 因此重试几帧；滚动本身带落点校正，见 lib/chat-scroll。
  useEffect(() => {
    const id = revealIdRef.current;
    if (!id) return;
    revealIdRef.current = null;
    let attempts = 0;
    let frame = 0;
    const attempt = () => {
      if (scrollToMessage(id)) return;
      if (attempts++ < 5) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [start]);

  // 前插更早消息后抵消高度差，保持用户当前阅读位置
  useLayoutEffect(() => {
    const previousHeight = prependHeightRef.current;
    if (previousHeight === null) return;
    prependHeightRef.current = null;
    const viewport = document.getElementById(CHAT_VIEWPORT_ID);
    if (!viewport) return;
    viewport.scrollTop += viewport.scrollHeight - previousHeight;
  }, [start, prependVersion]);

  const loadEarlier = () => {
    const viewport = document.getElementById(CHAT_VIEWPORT_ID);
    prependHeightRef.current = viewport?.scrollHeight ?? null;

    if (start > 0) {
      // 本地窗口里还有更早的消息：按预算继续展开
      setWindowStart((base) => earlierStartFor(messages, base));
      return;
    }

    if (!hasMore || loadingEarlier || !currentSessionId) {
      prependHeightRef.current = null;
      return;
    }

    // 本地窗口已经到底：向主进程取更早的一页
    void loadEarlierMessages(currentSessionId)
      .then((added) => {
        if (added > 0) {
          setMessageWindow({ sessionId: currentSessionId, start: 0 });
          setPrependVersion((value) => value + 1);
        } else {
          prependHeightRef.current = null;
        }
      })
      .catch(() => {
        prependHeightRef.current = null;
      });
  };

  /*
   * convertMessage 必须保持引用稳定。
   *
   * assistant-ui 以 callback 引用作为转换缓存的失效条件：回调每次渲染都新建，
   * 缓存就会整体丢弃，导致每来一个 token 都把**整个窗口**重新转换一遍
   * （重建 part、序列化每个工具调用参数）。长会话下这是最主要的卡顿来源。
   */
  const convertMessage = useCallback(
    (message: Message, index: number) =>
      toThreadMessage(message, streaming && index === messageCount - 1),
    [streaming, messageCount],
  );

  /*
   * store 对象保持引用稳定：useExternalStoreRuntime 内部每次渲染都会
   * setAdapter，adapter 引用不变时才能命中它的 early-return；不稳定的
   * 对象会让整窗快照更新在无关重渲染时也执行一次。
   */
  const runtimeStore = useMemo(
    () => ({
      messages: visibleMessages,
      isRunning: streaming,
      convertMessage,
      // 输入框仍由 Nova 管理，这里只借用 assistant-ui 的展示运行时。
      onNew: NOOP_ON_NEW,
    }),
    [visibleMessages, streaming, convertMessage],
  );
  const runtime = useExternalStoreRuntime<Message>(runtimeStore);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="relative h-full">
        <ThreadPrimitive.Viewport
          id={CHAT_VIEWPORT_ID}
          className="ui-chat-scale ui-chat-gutter h-full overflow-y-auto py-4"
        >
          {(start > 0 || hasMore) && (
            <div className="flex justify-center pb-3">
              <button
                type="button"
                onClick={loadEarlier}
                disabled={loadingEarlier}
                className="rounded-full border border-border/60 bg-surface-2/40 px-3 py-1 ui-type-note text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loadingEarlier ? "正在载入更早的消息…" : "载入更早的消息"}
              </button>
            </div>
          )}
          <ThreadPrimitive.Empty>
            <ThreadEmpty onSuggestion={onSuggestion} />
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function ThreadEmpty({
  onSuggestion,
}: {
  onSuggestion?: (text: string) => void;
}) {
  const projects = useChatStore((s) => s.projects);
  const currentProjectId = useChatStore((s) => s.currentProjectId);
  const loadingHistory = useChatStore(
    (s) =>
      s.loadingHistoryFor !== null &&
      s.loadingHistoryFor === s.currentSessionId,
  );
  const project = projects.find((p) => p.id === currentProjectId);

  if (loadingHistory) {
    return (
      <div className="history-loading ui-glass ui-ring mx-auto mt-[20vh] flex w-[260px] flex-col items-center gap-4 rounded-lg px-6 py-6">
        <div className="history-progress">
          <div className="history-progress-bar" />
        </div>
        <p className="ui-type-body tracking-wide text-text-secondary">
          历史记录正在恢复中
        </p>
      </div>
    );
  }

  return (
    <div className="ui-entrance relative flex min-h-full flex-col items-center justify-center px-6 py-10">
      {/* 入口的两次装饰：顶部弥散光 + 极轻噪点，离开空态即消失 */}
      <div aria-hidden className="ui-entrance-glow" />

      {/* 一次性的入场编排：品牌标记 → 标题 → 说明 → 起手式 → 快捷键提示 */}
      <div className="ui-entrance-stack relative z-10 flex w-full max-w-[620px] flex-col items-center text-center">
        <div className="ui-brand-mark overflow-hidden">
          <img
            src={logoAvatarUrl}
            alt="Nova"
            draggable={false}
            className="h-8 w-8 select-none object-cover"
          />
        </div>

        <h1 className="mt-6 ui-type-entrance text-text">Work is Agentic</h1>

        {/* 全站唯一的渐变元素：入口标题下的一条光谱细线 */}
        <div aria-hidden className="ui-spectral-rule mt-5" />

        <p className="mt-4 max-w-[520px] ui-type-body leading-relaxed text-text-secondary">
          {project
            ? `在「${project.name}」中开始工作。描述任务，或从下面的起手式开始。`
            : "描述任务，或从下面的起手式开始。需要读写本地文件时，在输入框旁指定工作区。"}
        </p>

        {/* 窄窗口（尤其右侧工作区展开时）保持单列，避免标签被截断 */}
        {onSuggestion && (
          <div className="mt-8 grid w-full grid-cols-1 border-b border-border min-[1400px]:grid-cols-2 min-[1400px]:gap-x-8">
            {SUGGESTIONS.map(({ icon: Icon, label, prompt }) => (
              <button
                key={label}
                type="button"
                onClick={() => onSuggestion(prompt)}
                className="ui-starter group"
              >
                <span className="ui-starter-icon">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
              </button>
            ))}
          </div>
        )}

        <p className="mt-6 ui-type-sub text-text-muted">
          Enter 发送 · Shift + Enter 换行
        </p>
      </div>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="relative mx-auto mb-4 flex max-w-[var(--c-layout-content)] justify-end last:mb-0">
      <UserBubble>
        <MessagePrimitive.Parts components={USER_PART_COMPONENTS} />
      </UserBubble>
      <NovaAvatar className="ui-chat-avatar-right" />
    </MessagePrimitive.Root>
  );
}

function UserTextPart() {
  const part = useMessagePartText();
  // 纯图片消息没有正文：空字符串不要占出行高
  return part.text ? <>{part.text}</> : null;
}

function UserImagePart() {
  const part = useMessagePartImage();
  return (
    <img
      src={part.image}
      alt={part.filename ?? "图片"}
      className="mb-1.5 max-h-64 w-auto max-w-full rounded-lg border border-border/50 object-contain last:mb-0"
    />
  );
}

/** 用户消息里的引用块：文件 / 会话 / 工具 / 技能 / 知识库 */
function UserReferencePart(
  props: DataMessagePartProps<{
    kind: ReferenceKind;
    name: string;
    detail?: string;
  }>,
) {
  return <ReferenceBlock {...props.data} />;
}

/**
 * system 消息：时间线上的上下文分界。
 *
 * 切换工作区后由主进程写入，显示为一条安静的分界提示。
 * 不带头像，也不套助手回复的气泡。
 */
function SystemMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto mb-4 flex max-w-[var(--c-layout-content)] items-center gap-3 last:mb-0">
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border/80" />
      <div className="min-w-0 shrink-0 px-1 text-center ui-type-sub leading-relaxed text-text-muted">
        <MessagePrimitive.Parts components={SYSTEM_PART_COMPONENTS} />
      </div>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border/80" />
    </MessagePrimitive.Root>
  );
}

function SystemTextPart() {
  const part = useMessagePartText();
  return <>{part.text}</>;
}

function AssistantMessage() {
  const agents = useChatStore((s) => s.agents);
  const agentId = useChatStore(selectEffectiveAgentId);
  const employees = useEmployeesStore((s) => s.employees);
  /*
   * 回答者优先级：消息自己记录 > 会话当前绑定。
   *
   * 消息上记的是「这条回复当时谁答的」，所以中途换员工不会把历史回复的
   * 头像一起改掉；undefined 才是真的没有记录（旧数据 / CLI 回放），
   * 此时回退到会话绑定。显式 null 表示当时就没用数字员工。
   */
  const sessionEmployeeId = useChatStore(selectEffectiveEmployeeId);
  const messageEmployeeId = useAuiState((s) => {
    const value = s.message.metadata.custom.employeeId;
    return typeof value === "string" || value === null ? value : undefined;
  });
  const employee = useMemo(() => {
    const id = messageEmployeeId === undefined ? sessionEmployeeId : messageEmployeeId;
    return id ? (employees.find((item) => item.id === id) ?? null) : null;
  }, [messageEmployeeId, sessionEmployeeId, employees]);
  /*
   * 用消息级状态而不是某个 part 的状态：思考 / 调工具 / 写正文都算「在跑」。
   * 挂在 part 上时，只要当前正在产出思考块，正文 part 就处于完成态，
   * 提示语会时隐时现。消息级状态在整个回复结束前一直为 running。
   */
  const running = useAuiState((s) => s.message.status?.type === "running");

  return (
    <MessagePrimitive.Root className="group/message relative mx-auto mb-4 max-w-[var(--c-layout-content)] last:mb-0">
      {employee ? (
        <EmployeeChatAvatar
          employee={employee}
          className="ui-chat-avatar-left"
        />
      ) : (
        <AgentAvatar
          agents={agents}
          agentId={agentId}
          className="ui-chat-avatar-left"
        />
      )}
      {/* 同一回复内的 part 间距统一由 gap 控制，part 自身不再带下边距，
          否则「最后一块是什么」会改变消息尾部的留白。 */}
      <div className="flex w-full min-w-0 flex-col gap-2">
        <MessagePrimitive.Parts components={ASSISTANT_PART_COMPONENTS} />
        {/* 固定在整条回复末尾：不论是思考、工具调用还是正文流式，只要没结束就一直在 */}
        {running && <WorkingIndicator />}
        {/* 回复结束后才出现：流式复制到一半的文本没有意义 */}
        {!running && <CopyAnswerButton />}
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * 「复制整条回答」按钮。
 *
 * 只聚合正文 part：思考过程与工具输出不属于用户想带走的那段文案，
 * 混进剪贴板反而要再手工删一遍。多段正文之间用空行连接，保持段落分隔。
 *
 * 按钮常驻占一行高度（只做透明度过渡），否则悬停时出现会把下面的消息
 * 整体推下去，阅读时视线跟着跳。
 */
function CopyAnswerButton() {
  const text = useAuiState((s) =>
    s.message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter(Boolean)
      .join("\n\n"),
  );
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  if (!text) return null;

  const copy = () => {
    void copyText(text).then((ok) => {
      if (!ok) {
        toast.error("复制失败，请手动选择文本");
        return;
      }
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="flex h-6 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100">
      <button
        type="button"
        onClick={copy}
        title={copied ? "已复制" : "复制整条回答"}
        aria-label={copied ? "已复制" : "复制整条回答"}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 ui-type-sub text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        <span>{copied ? "已复制" : "复制"}</span>
      </button>
    </div>
  );
}

/** 「Nova is working...」——回复进行中的常驻状态提示 */
function WorkingIndicator() {
  return (
    <div className="flex items-center" role="status">
      {/* 整句流光：让「正在工作」这件事在字面上持续流动 */}
      <span className="shimmer shimmer-fast ui-type-body italic tracking-wide">
        Nova is working...
      </span>
    </div>
  );
}

function AnswerPart() {
  /*
   * 直接渲染权威文本，不再套 useSmooth 的打字机动画。
   *
   * useSmooth 会在 part 对象身份变化（流式时每个 delta 都会新建）时把
   * 已显示文本清空重播，于是文字永远追不上流，表现为“一个字一个字往外蹦”。
   * 事件已经由主进程 + 渲染进程合并过，直接渲染本身就是平滑的。
   */
  const part = useMessagePartText();
  const running = part.status.type === "running";
  /*
   * Markdown 解析是 O(文本长度) 的，而且流式期间每次都要从头解析。
   * 固定 80ms 在长回复上会明显吃掉主线程（实测 32KB 单次约 48ms），
   * 因此间隔随文本长度自适应：短文本保持打字机手感，长文本降低刷新频率。
   */
  const text = useThrottledValue(part.text, markdownInterval(part.text.length));

  // 助手正文不再套气泡外框：正文直接落在内容列上，与输入框左右对齐
  return (
    <div className="w-full text-text">
      <StreamingMarkdown content={text} streaming={running} />
    </div>
  );
}

function ReasoningPart() {
  const part = useMessagePartReasoning();
  const running = part.status.type === "running";
  // 思考块默认折叠，展开时同样需要节流（原因见 AnswerPart）
  const text = useThrottledValue(part.text, markdownInterval(part.text.length, 120));

  return <ThinkingCard text={text} running={running} />;
}

function ToolPart(props: ToolCallMessagePartProps) {
  const meta = readNovaToolMetadata(props.providerMetadata);
  const kind = meta?.kind ?? "other";
  const target = meta?.target || readToolTarget(props.args);
  const hasError = !!props.isError;
  const done = props.result !== undefined;
  /*
   * 只有运行中的消息才显示“进行中”。
   * 运行被中断 / 超时 / 进程异常结束时，已发出的 tool_call 可能永远等不到
   * result；此时消息本身已经结束，不能再把它显示成“一直进行中”。
   */
  const running = props.status?.type === "running";
  /*
   * 改动类工具（Edit / Write / MultiEdit…）把 input 里的新旧文本转成 diff。
   * 只在参数对象变化时重算：历史消息按消息缓存转换结果，不会反复执行。
   */
  const changes = useMemo(
    () => extractFileChanges(props.toolName, props.args, kind, meta?.lineStarts),
    [props.toolName, props.args, kind, meta?.lineStarts],
  );
  /*
   * 结果对象在每次转换时都会重建（`{ output, isError, images }`），但内部的
   * images 数组引用来自事件本身、是稳定的。按 images 引用缓存过滤结果：
   * 否则每次刷新都会得到一个新数组，memo 化的 ToolCallCard 等于失效。
   */
  const rawImages =
    props.result && typeof props.result === "object"
      ? (props.result as { images?: unknown }).images
      : undefined;
  const resultImages = useMemo(
    () => readResultImages(rawImages),
    [rawImages],
  );
  /*
   * 工具输出可能很大，JSON.stringify 是 O(输出长度)。卡片在每次消息列表
   * 重挂载 / 重渲染时都会走到这里，按 result 引用缓存一次即可。
   */
  const resultText = useMemo(
    () => (done ? stringifyToolResult(props.result) : undefined),
    [done, props.result],
  );

  return (
    <ToolCallCard
      toolName={props.toolName}
      target={target}
      kind={kind}
      args={props.args}
      argsText={props.argsText}
      result={resultText}
      resultImages={resultImages}
      isError={hasError}
      running={running}
      changes={changes}
    />
  );
}

function ErrorPart(props: DataMessagePartProps<{ message: string }>) {
  const retry = () => {
    const state = useChatStore.getState();
    const sessionId = state.currentSessionId;
    if (!sessionId) {
      toast.error("当前没有可重试的会话");
      return;
    }
    const messages = state.messagesBySession[sessionId] ?? [];
    const lastUser = [...messages].reverse().find((item) => item.role === "user");
    const text = lastUser ? textFromEvents(lastUser.content) : "";
    /*
     * 重试要把引用一起带上：引用说明不在展示正文里，
     * 用落库时保留的 promptText 重建完整 prompt。
     */
    const references: DisplayReference[] = lastUser
      ? lastUser.content
          .filter(
            (event): event is Extract<AgentEvent, { type: "reference" }> =>
              event.type === "reference",
          )
          .map((event) => ({
            kind: event.kind,
            name: event.name,
            detail: event.detail,
            promptText: event.promptText,
          }))
      : [];
    const prompt = [
      text,
      ...references
        .map((reference) => reference.promptText)
        .filter((value): value is string => Boolean(value)),
    ].join("\n");
    if (!prompt.trim()) {
      toast.error("没有找到可重试的用户消息");
      return;
    }
    void state.sendMessage(prompt, text, undefined, references).catch((err) => {
      toast.error(toMessage(err), 5000);
    });
  };

  const copy = () => {
    void navigator.clipboard
      .writeText(props.data.message)
      .then(() => toast.success("错误信息已复制"))
      .catch(() => toast.error("复制失败"));
  };

  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-error/30 bg-error-bg/70 px-3.5 py-2.5 ui-type-body text-error">
      <Bug className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap">
        {props.data.message}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={retry}
          title="重试上一条消息"
          aria-label="重试上一条消息"
          className="rounded-sm p-1 text-error/80 transition-colors hover:bg-error/10 hover:text-error"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={copy}
          title="复制错误信息"
          aria-label="复制错误信息"
          className="rounded-sm p-1 text-error/80 transition-colors hover:bg-error/10 hover:text-error"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}

function WarningPart(props: DataMessagePartProps<{ message: string }>) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-surface-2/40 px-3.5 py-2.5 ui-type-body text-text-secondary">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
      <span className="min-w-0">{props.data.message}</span>
    </div>
  );
}

function toThreadMessage(message: Message, streaming: boolean): ThreadMessageLike {
  if (message.role === "system") {
    // 宿主写入的分隔提示：不是 Agent 回复，渲染成时间线上的分界线
    return {
      id: message.id,
      role: "system",
      createdAt: new Date(message.timestamp),
      content: textFromEvents(message.content),
    };
  }

  if (message.role === "user") {
    return {
      id: message.id,
      role: "user",
      createdAt: new Date(message.timestamp),
      content: userContentParts(message.content),
    };
  }

  return {
    id: message.id,
    role: "assistant",
    createdAt: new Date(message.timestamp),
    status: streaming
      ? { type: "running" }
      : { type: "complete", reason: "stop" },
    content: assistantParts(message),
    /*
     * 回答者随消息一起带进 assistant-ui 的展示层。
     * 只有「确实记录过」才写这个键：undefined 要留给渲染时回退到会话绑定，
     * 直接写成 null 会被误读成「当时就没用员工」。
     */
    ...(message.employeeId !== undefined
      ? { metadata: { custom: { employeeId: message.employeeId } } }
      : {}),
  };
}

function assistantParts(
  message: Message,
): Extract<ThreadMessageLike["content"], readonly unknown[]> {
  const parts: any[] = [];

  /*
   * 历史消息修复：旧版解码在并行工具调用时可能把同一个 callId 的
   * tool_call 记录两次，而 tool_result 只有一份。顺序配对只能关掉其中
   * 一个，另一份会永久停在“进行中”。这里按 callId 收集已有结果，
   * 最后把仍未配对的同名调用一并补上结果（重复的那份也视为完成）。
   */
  const resultsByCall = new Map<
    string,
    { output: string; isError?: boolean; images?: ToolResultImage[] }
  >();
  for (const event of message.content) {
    if (event.type === "tool_result" && event.callId && !resultsByCall.has(event.callId)) {
      resultsByCall.set(event.callId, {
        output: event.output,
        isError: event.isError,
        images: event.images,
      });
    }
  }

  for (const event of message.content) {
    switch (event.type) {
      case "thinking":
        parts.push({ type: "reasoning", id: `${message.id}-reason-${parts.length}`, text: event.content });
        break;
      case "text":
        parts.push({ type: "text", id: `${message.id}-text-${parts.length}`, text: event.content });
        break;
      case "tool_call":
        parts.push({
          type: "tool-call",
          toolCallId: event.callId ?? `${message.id}-tool-${parts.length}`,
          toolName: event.name,
          args: asJSONObject(event.input),
          argsText: formatJson(event.input),
          providerMetadata: {
            nova: {
              kind: event.kind,
              target: event.target,
              lineStarts: event.lineStarts,
            },
          },
        });
        break;
      case "tool_result": {
        const index = findOpenTool(parts, event.name, event.callId);
        const result = {
          output: event.output,
          isError: event.isError,
          images: event.images,
        };
        if (index >= 0) {
          const part = parts[index];
          parts[index] = {
            ...part,
            result,
            isError: !!event.isError,
          };
        } else {
          parts.push({
            type: "tool-call",
            toolCallId: `${message.id}-tool-${parts.length}`,
            toolName: event.name,
            args: {},
            result,
            isError: !!event.isError,
          });
        }
        break;
      }
      case "error":
        parts.push({
          type: "data",
          name: "novaError",
          data: { message: event.message },
        });
        break;
      case "warning":
        parts.push({
          type: "data",
          name: "novaWarning",
          data: { message: event.message },
        });
        break;
      case "message_end":
        parts.push(...assistantParts({ ...message, content: event.blocks }));
        break;
      default:
        break;
    }
  }

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part?.type !== "tool-call" || part.result !== undefined) continue;
    const result = resultsByCall.get(part.toolCallId);
    if (result) parts[i] = { ...part, result, isError: !!result.isError };
  }

  return parts;
}

function findOpenTool(parts: any[], name: string, callId?: string): number {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (
      part?.type === "tool-call" &&
      part.result === undefined &&
      (callId ? part.toolCallId === callId : part.toolName === name)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * 用户消息 → assistant-ui parts。
 * 图片转成 data URL；纯图片消息没有 text part，避免气泡里多出一行空白。
 */
function userContentParts(
  events: AgentEvent[],
): Extract<ThreadMessageLike["content"], readonly unknown[]> {
  const parts: any[] = [];
  for (const event of events) {
    if (event.type === "text") {
      if (event.content) parts.push({ type: "text", text: event.content });
    } else if (event.type === "image") {
      const src = imageSrc(event);
      if (src) parts.push({ type: "image", image: src });
    } else if (event.type === "reference") {
      parts.push({
        type: "data",
        name: "novaReference",
        data: {
          kind: event.kind,
          name: event.name,
          detail: event.detail,
        },
      });
    }
  }
  return parts;
}

function textFromEvents(events: AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.content)
    .join("");
}

function asJSONObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { value: input };
}

function readNovaToolMetadata(
  metadata: ToolCallMessagePartProps["providerMetadata"],
): { kind: ToolKind; target: string; lineStarts?: number[] } | null {
  const nova = metadata?.nova as
    | { kind?: ToolKind; target?: string; lineStarts?: number[] }
    | undefined;
  if (!nova) return null;
  return {
    kind: nova.kind ?? "other",
    target: nova.target ?? "",
    lineStarts: nova.lineStarts,
  };
}

function readToolTarget(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return readStringField(
    args as Record<string, unknown>,
    TOOL_TARGET_KEYS,
  );
}

/** tool-call part 的 result.images 里携带的工具输出图片 */
function readResultImages(images: unknown): ToolResultImage[] | undefined {
  if (!Array.isArray(images)) return undefined;
  const valid = images.filter(
    (image): image is ToolResultImage =>
      !!image &&
      typeof image === "object" &&
      typeof (image as { mediaType?: unknown }).mediaType === "string" &&
      (typeof (image as { data?: unknown }).data === "string" ||
        typeof (image as { ref?: unknown }).ref === "string"),
  );
  return valid.length > 0 ? valid : undefined;
}

function stringifyToolResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (
    typeof result === "object" &&
    "output" in result &&
    typeof (result as { output?: unknown }).output === "string"
  ) {
    return (result as { output: string }).output;
  }
  return formatJson(result);
}
