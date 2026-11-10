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
  useMessagePartReasoning,
  useMessagePartText,
  type DataMessagePartProps,
  type ThreadMessageLike,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  Bug,
  FileText,
  FolderTree,
  ListChecks,
  Sparkles,
  AlertTriangle,
} from "lucide-react";
import type { AgentEvent, Message, ToolKind, ToolResultImage } from "@shared/types";
import { clamp } from "@shared/math";
import { TOOL_TARGET_KEYS, readStringField } from "@shared/tool-input";
import {
  selectCurrentMessages,
  selectEffectiveAgentId,
  useChatStore,
} from "../../stores/chat";
import { REVEAL_MESSAGE_EVENT } from "../../lib/chat-events";
import { CHAT_VIEWPORT_ID, scrollToMessage } from "../../lib/chat-scroll";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { AgentAvatar, NovaAvatar } from "../ui/MessageAvatar";
import { UserBubble } from "../ui/UserBubble";
import { extractFileChanges } from "../../lib/tool-diff";
import { markdownInterval, useThrottledValue } from "../../hooks/useThrottledValue";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingCard } from "./ThinkingCard";

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

/** 首次只挂载最近多少条消息；更早的按需展开 */
const INITIAL_MESSAGE_WINDOW = 120;
/** 每次「载入更早」增加多少条 */
const LOAD_EARLIER_STEP = 80;

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
   * 窗口化：只把最近一段消息交给 assistant-ui。
   *
   * 长会话下真正昂贵的是「转换 + 渲染所有历史消息」，仅靠 CSS 跳过绘制
   * 并不能省掉 React/Markdown 的成本。这里默认只挂载最近 120 条，顶部
   * 提供「载入更早」，既保留可回看能力，又让打开长会话的成本与长度无关。
   */
  const [windowStart, setWindowStart] = useState(() =>
    Math.max(0, messages.length - INITIAL_MESSAGE_WINDOW),
  );
  /** 载入更早前的高度，用于抵消前插造成的滚动跳变 */
  const prependHeightRef = useRef<number | null>(null);
  /** 需要展开窗口后滚动到的消息 id（问题导航点击未挂载消息时） */
  const revealIdRef = useRef<string | null>(null);
  /** 记录已经为哪个会话初始化过窗口，避免每次消息增长都重置 */
  const initializedSessionRef = useRef<string | null>(null);

  const total = messages.length;
  // 会话切换后的第一帧可能还用着上一个会话的 windowStart，先夹紧避免越界
  const start = clamp(windowStart, 0, total - 1);
  const visibleMessages = useMemo(
    () => messages.slice(start),
    [messages, start],
  );
  const messageCount = visibleMessages.length;

  // 会话切换 / 历史到达时，把窗口定位到「最近 N 条」
  useEffect(() => {
    if (!currentSessionId) {
      initializedSessionRef.current = null;
      return;
    }
    if (initializedSessionRef.current === currentSessionId) return;
    if (messages.length === 0) return; // 等历史回放完成再定位
    initializedSessionRef.current = currentSessionId;
    setWindowStart(Math.max(0, messages.length - INITIAL_MESSAGE_WINDOW));
  }, [currentSessionId, messages.length]);

  // 问题导航请求查看一条可能尚未挂载的消息
  const revealStateRef = useRef({ messages, start });
  revealStateRef.current = { messages, start };
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

      // 目标在窗口之前：向前扩到目标附近，渲染完成后再滚动
      revealIdRef.current = id;
      setWindowStart(Math.max(0, index - 5));
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
  }, [start]);

  const loadEarlier = () => {
    if (start <= 0) return;
    const viewport = document.getElementById(CHAT_VIEWPORT_ID);
    prependHeightRef.current = viewport?.scrollHeight ?? null;
    setWindowStart((current) => Math.max(0, current - LOAD_EARLIER_STEP));
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

  const runtime = useExternalStoreRuntime<Message>({
    messages: visibleMessages,
    isRunning: streaming,
    convertMessage,
    // 输入框仍由 Nova 管理，这里只借用 assistant-ui 的展示运行时。
    onNew: async () => {},
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="relative h-full">
        <ThreadPrimitive.Viewport
          id={CHAT_VIEWPORT_ID}
          className="ui-chat-scale ui-chat-gutter h-full overflow-y-auto py-4"
        >
          {start > 0 && (
            <div className="flex justify-center pb-3">
              <button
                type="button"
                onClick={loadEarlier}
                className="rounded-full border border-border/60 bg-surface-2/40 px-3 py-1 ui-type-note text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
              >
                载入更早的 {Math.min(start, LOAD_EARLIER_STEP)} 条消息
              </button>
            </div>
          )}
          <ThreadPrimitive.Empty>
            <ThreadEmpty onSuggestion={onSuggestion} />
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages
            components={{
              UserMessage: UserMessage,
              AssistantMessage: AssistantMessage,
            }}
          />
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
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-8">
      <div className="relative w-full max-w-[680px] overflow-hidden rounded-2xl border border-border/60 bg-surface-2/40 p-8 shadow-[var(--c-shadow-sm)]">
        {/* 编辑式空态：一条静态强调线代替渐变/光晕 */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-10 top-0 h-px bg-accent/30"
        />

        <div className="relative flex flex-col items-center text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-accent text-accent-foreground shadow-[var(--c-shadow-sm)]">
            <Sparkles className="h-6 w-6" />
          </div>

          <h1 className="mt-5 ui-type-heading tracking-tight text-text">
            {project ? `在「${project.name}」中开始对话` : "有什么可以帮你？"}
          </h1>
          <p className="mt-2 max-w-md ui-type-body leading-relaxed text-text-secondary">
            {project
              ? "描述任务，或从下面的示例开始。Nova 会在当前工作目录中读取和改动文件。"
              : "描述你的任务，或从下面的示例开始。需要读写本地文件时，在输入框旁指定工作区。"}
          </p>

          {onSuggestion && (
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map(({ icon: Icon, label, prompt }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => onSuggestion(prompt)}
                  className="flex items-center gap-1.5 rounded-full border border-border/60 bg-surface/80 px-3 py-1.5 ui-type-note text-text-secondary shadow-[var(--c-shadow-sm)] transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
          )}

          <p className="mt-6 ui-type-sub text-text-muted">
            Enter 发送 · Shift + Enter 换行
          </p>
        </div>
      </div>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="relative mx-auto mb-4 flex max-w-[var(--c-layout-content)] justify-end last:mb-0">
      <UserBubble>
        <MessagePrimitive.Parts components={{ Text: UserTextPart }} />
      </UserBubble>
      <NovaAvatar className="ui-chat-avatar-right" />
    </MessagePrimitive.Root>
  );
}

function UserTextPart() {
  const part = useMessagePartText();
  return <>{part.text}</>;
}

function AssistantMessage() {
  const agents = useChatStore((s) => s.agents);
  const agentId = useChatStore(selectEffectiveAgentId);
  /*
   * 用消息级状态而不是某个 part 的状态：思考 / 调工具 / 写正文都算「在跑」。
   * 挂在 part 上时，只要当前正在产出思考块，正文 part 就处于完成态，
   * 提示语会时隐时现。消息级状态在整个回复结束前一直为 running。
   */
  const running = useAuiState((s) => s.message.status?.type === "running");

  return (
    <MessagePrimitive.Root className="relative mx-auto mb-4 max-w-[var(--c-layout-content)] last:mb-0">
      <AgentAvatar
        agents={agents}
        agentId={agentId}
        className="ui-chat-avatar-left"
      />
      {/* 同一回复内的 part 间距统一由 gap 控制，part 自身不再带下边距，
          否则「最后一块是什么」会改变消息尾部的留白。 */}
      <div className="flex w-full min-w-0 flex-col gap-2">
        <MessagePrimitive.Parts
          components={{
            Text: AnswerPart,
            Reasoning: ReasoningPart,
            data: {
              by_name: {
                novaError: ErrorPart,
                novaWarning: WarningPart,
              },
            },
            tools: { Fallback: ToolPart },
          }}
        />
        {/* 固定在整条回复末尾：不论是思考、工具调用还是正文流式，只要没结束就一直在 */}
        {running && <WorkingIndicator />}
      </div>
    </MessagePrimitive.Root>
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
      <MarkdownRenderer content={text} streaming={running} />
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
  const resultImages = readResultImages(props.result);

  return (
    <ToolCallCard
      toolName={props.toolName}
      target={target}
      kind={kind}
      args={props.args}
      argsText={props.argsText}
      result={done ? stringifyToolResult(props.result) : undefined}
      resultImages={resultImages}
      isError={hasError}
      running={running}
      changes={changes}
    />
  );
}

function ErrorPart(props: DataMessagePartProps<{ message: string }>) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-error/30 bg-error-bg/70 px-3.5 py-2.5 ui-type-body text-error">
      <Bug className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0">{props.data.message}</span>
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
  if (message.role === "user") {
    return {
      id: message.id,
      role: "user",
      createdAt: new Date(message.timestamp),
      content: [{ type: "text", text: textFromEvents(message.content) }],
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
          argsText: JSON.stringify(event.input ?? {}, null, 2),
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

/** tool-call part 的 result 里携带的工具输出图片 */
function readResultImages(result: unknown): ToolResultImage[] | undefined {
  if (!result || typeof result !== "object") return undefined;
  const images = (result as { images?: unknown }).images;
  if (!Array.isArray(images)) return undefined;
  const valid = images.filter(
    (image): image is ToolResultImage =>
      !!image &&
      typeof image === "object" &&
      typeof (image as { mediaType?: unknown }).mediaType === "string" &&
      typeof (image as { data?: unknown }).data === "string",
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
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
