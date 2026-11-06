/**
 * assistant-ui 消息列表适配层
 *
 * Nova 继续持有 AgentEvent / Zustand / SQLite；本组件只把领域事件转换成
 * assistant-ui 的 ThreadMessageLike，并使用其 Thread / Message / Part 原语渲染。
 * 视觉样式全部走 Nova 的语义 token，因此昼夜皮肤自动兼容。
 */

import { useCallback, useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessagePartReasoning,
  useMessagePartText,
  type DataMessagePartProps,
  type ThreadMessageLike,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  Brain,
  Bug,
  ChevronRight,
  FileText,
  Loader2,
  PenLine,
  Search,
  Terminal,
  Wrench,
  AlertTriangle,
} from "lucide-react";
import type { AgentEvent, Message, ToolKind } from "@shared/types";
import { selectEffectiveAgentId, useChatStore } from "../../stores/chat";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { AgentAvatar, NovaAvatar } from "../ui/MessageAvatar";
import { UserBubble } from "../ui/UserBubble";
import { truncateText } from "../../lib/utils";
import { extractFileChanges } from "../../lib/tool-diff";
import { ToolDiffView } from "./ToolDiffView";
import { markdownInterval, useThrottledValue } from "../../hooks/useThrottledValue";

export function AssistantMessageList() {
  const messages = useChatStore((s) => s.messagesBySession[s.currentSessionId ?? ""] ?? []);
  const streaming = useChatStore(
    (s) => !!s.streamingBySession[s.currentSessionId ?? ""],
  );
  const messageCount = messages.length;

  /*
   * convertMessage 必须保持引用稳定。
   *
   * assistant-ui 以 callback 引用作为转换缓存的失效条件：回调每次渲染都新建，
   * 缓存就会整体丢弃，导致每来一个 token 都把**整个会话**重新转换一遍
   * （重建 part、序列化每个工具调用参数）。长会话下这是最主要的卡顿来源。
   */
  const convertMessage = useCallback(
    (message: Message, index: number) =>
      toThreadMessage(message, streaming && index === messageCount - 1),
    [streaming, messageCount],
  );

  const runtime = useExternalStoreRuntime<Message>({
    messages,
    isRunning: streaming,
    convertMessage,
    // 输入框仍由 Nova 管理，这里只借用 assistant-ui 的展示运行时。
    onNew: async () => {},
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="relative h-full">
        <ThreadPrimitive.Viewport className="ui-chat-scale ui-chat-gutter h-full overflow-y-auto py-4">
          <ThreadPrimitive.Empty>
            <ThreadEmpty />
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

function ThreadEmpty() {
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
        <p className="ui-serif text-body tracking-wide text-text-secondary">
          历史记录正在恢复中
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-[var(--c-layout-content)] flex-col items-center justify-center gap-3 text-text-muted">
      <div className="ui-btn-round flex h-14 w-14 items-center justify-center rounded-full">
        <Brain className="h-5 w-5" />
      </div>
      <h1 className="ui-serif text-hero font-semibold tracking-wide text-text-secondary">
        {project ? "开始对话" : "新对话"}
      </h1>
      <p className="max-w-md text-center text-body-lg leading-relaxed">
        {project
          ? `在「${project.name}」工作目录中与智能体对话`
          : "直接描述你的任务。需要读写本地文件时，在输入框旁指定工作区。"}
      </p>
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
      </div>
    </MessagePrimitive.Root>
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

  return (
    <div className="ui-bubble w-fit max-w-full bg-surface-2 px-4 py-3 text-text">
      <MarkdownRenderer content={text} streaming={running} />
      {running && (
        <span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse rounded-full bg-accent align-middle" />
      )}
    </div>
  );
}

function ReasoningPart() {
  const [collapsed, setCollapsed] = useState(true);
  const part = useMessagePartReasoning();
  const running = part.status.type === "running";
  // 思考块默认折叠，展开时同样需要节流（原因见 AnswerPart）
  const text = useThrottledValue(part.text, markdownInterval(part.text.length, 120));

  return (
    <div className="group max-w-full">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="ui-glass flex items-center gap-2 rounded-md px-2.5 py-1.5 text-meta text-thinking hover:text-text-secondary"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="ui-serif">思考过程</span>
        {running && <Loader2 className="h-3 w-3 animate-spin" />}
        <ChevronRight
          className={`h-3 w-3 text-text-muted transition-transform ${
            collapsed ? "" : "rotate-90"
          }`}
        />
      </button>

      {!collapsed && (
        <div className="mt-2 max-h-60 overflow-auto rounded-md border-l-4 border-thinking bg-thinking-bg px-4 py-3 text-meta text-text-secondary backdrop-blur-md">
          <MarkdownRenderer content={text} streaming={running} />
        </div>
      )}
    </div>
  );
}

const TOOL_ICONS: Record<ToolKind, typeof FileText> = {
  read: FileText,
  write: PenLine,
  exec: Terminal,
  search: Search,
  other: Wrench,
};

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
  const statusText = done
    ? hasError
      ? "失败"
      : "完成"
    : running
      ? "进行中"
      : "未完成";
  const Icon = TOOL_ICONS[kind];
  const output = stringifyToolResult(props.result);
  /*
   * 改动类工具（Edit / Write / MultiEdit…）把 input 里的新旧文本转成 diff。
   * 只在参数对象变化时重算：历史消息按消息缓存转换结果，不会反复执行。
   */
  const changes = useMemo(
    () => extractFileChanges(props.toolName, props.args, kind, meta?.lineStarts),
    [props.toolName, props.args, kind, meta?.lineStarts],
  );
  /*
   * 改动类工具默认展开：diff 本身就是这类调用最值得看的内容，
   * 再收起来等于让用户多点一次。其余工具保持折叠。
   */
  const [collapsed, setCollapsed] = useState(() => changes.length === 0);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="ui-glass flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-meta text-text-secondary hover:text-text"
      >
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tool" />
        <span className="shrink-0 font-mono">{props.toolName}</span>
        {target && (
          /* 单行展示：换行（如 bash 多行命令）折叠成空格，超宽由 CSS 省略号截断，
             完整内容仍在 title / 展开明细里 */
          <span
            className="min-w-0 flex-1 truncate font-mono text-text-muted"
            title={target}
          >
            {target}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              hasError
                ? "bg-error"
                : done
                  ? "bg-success"
                  : running
                    ? "animate-pulse bg-accent"
                    : "bg-text-muted"
            }`}
          />
          <span className={hasError ? "text-error" : "text-text-muted"}>
            {statusText}
          </span>
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-text-muted transition-transform ${
              collapsed ? "" : "rotate-90"
            }`}
          />
        </span>
      </button>

      {!collapsed && (
        <div className="mt-1 w-full space-y-1">
          {changes.length > 0 ? (
            <ToolDiffView changes={changes} />
          ) : (
            <div>
              <div className="text-micro uppercase tracking-wide text-text-muted">
                input
              </div>
              <pre className="ui-glass max-h-40 overflow-auto rounded-md px-2 py-1 text-meta text-text-secondary">
                {truncateText(
                  props.argsText || JSON.stringify(props.args ?? {}, null, 2),
                  500,
                )}
              </pre>
            </div>
          )}
          {/* 有 diff 且成功时回执没有信息量（Edit 只回一句“已更新”），不再展示；
              失败时错误信息必须保留 */}
          {done && output && (changes.length === 0 || hasError) && (
            <div>
              <div className="text-micro uppercase tracking-wide text-text-muted">
                {hasError ? "error" : "output"}
              </div>
              <pre
                className={`ui-glass max-h-48 overflow-auto rounded-md px-2 py-1 text-meta ${
                  hasError ? "text-error" : "text-text-muted"
                }`}
              >
                {truncateText(output, 500)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ErrorPart(props: DataMessagePartProps<{ message: string }>) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-error bg-error-bg px-3 py-2 text-body-lg text-error">
      <Bug className="mt-0.5 h-4 w-4 shrink-0" />
      {props.data.message}
    </div>
  );
}

function WarningPart(props: DataMessagePartProps<{ message: string }>) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-body-lg text-text-secondary">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
      {props.data.message}
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
  const resultsByCall = new Map<string, { output: string; isError?: boolean }>();
  for (const event of message.content) {
    if (event.type === "tool_result" && event.callId && !resultsByCall.has(event.callId)) {
      resultsByCall.set(event.callId, {
        output: event.output,
        isError: event.isError,
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
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file", "filePath", "file_path", "command", "pattern", "query"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
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
