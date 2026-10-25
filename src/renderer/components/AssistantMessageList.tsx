/**
 * assistant-ui 消息列表适配层
 *
 * Nova 继续持有 AgentEvent / Zustand / SQLite；本组件只把领域事件转换成
 * assistant-ui 的 ThreadMessageLike，并使用其 Thread / Message / Part 原语渲染。
 * 视觉样式全部走 Nova 的语义 token，因此昼夜皮肤自动兼容。
 */

import { useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessagePartReasoning,
  useMessagePartText,
  useSmooth,
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
import { selectEffectiveAgentId, useChatStore } from "../stores/chat";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { AgentAvatar, NovaAvatar } from "./ui/MessageAvatar";
import { truncateText } from "../lib/utils";

export function AssistantMessageList() {
  const messages = useChatStore((s) => s.messagesBySession[s.currentSessionId ?? ""] ?? []);
  const streaming = useChatStore(
    (s) => !!s.streamingBySession[s.currentSessionId ?? ""],
  );

  const runtime = useExternalStoreRuntime<Message>({
    messages,
    isRunning: streaming,
    convertMessage: (message, index) =>
      toThreadMessage(message, streaming && index === messages.length - 1),
    // 输入框仍由 Nova 管理，这里只借用 assistant-ui 的展示运行时。
    onNew: async () => {},
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="relative h-full">
        <ThreadPrimitive.Viewport className="ui-chat-scale h-full overflow-y-auto px-4 py-4">
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
          : "直接描述你的任务。需要读写本地文件时，在输入框旁绑定项目目录。"}
      </p>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto mb-4 flex max-w-[var(--c-layout-content)] items-start justify-end gap-2.5">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-border-strong bg-bubble-user px-4 py-2.5 text-body-lg text-bubble-user-text shadow-[var(--c-shadow-sm)]">
        <MessagePrimitive.Parts components={{ Text: UserTextPart }} />
      </div>
      <NovaAvatar className="mt-0.5" />
    </MessagePrimitive.Root>
  );
}

function UserTextPart() {
  const part = useSmooth(useMessagePartText(), false);
  return <>{part.text}</>;
}

function AssistantMessage() {
  const agents = useChatStore((s) => s.agents);
  const agentId = useChatStore(selectEffectiveAgentId);

  return (
    <MessagePrimitive.Root className="mx-auto mb-4 flex max-w-[var(--c-layout-content)] items-start gap-2.5">
      <AgentAvatar agents={agents} agentId={agentId} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
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
  const part = useSmooth(useMessagePartText(), {
    drainMs: 260,
    maxCharsPerFrame: 80,
  });
  const running = part.status.type === "running";

  return (
    <div className="mb-2">
      <div className="ui-bubble w-fit max-w-full bg-surface-2 px-4 py-3 text-text">
        <MarkdownRenderer content={part.text} />
        {running && (
          <span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse rounded-full bg-accent align-middle" />
        )}
      </div>
    </div>
  );
}

function ReasoningPart() {
  const [collapsed, setCollapsed] = useState(true);
  const part = useSmooth(useMessagePartReasoning(), {
    drainMs: 320,
    maxCharsPerFrame: 80,
  });
  const running = part.status.type === "running";

  return (
    <div className="group mb-3 max-w-full">
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
          <MarkdownRenderer content={part.text} />
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
  const [collapsed, setCollapsed] = useState(true);
  const meta = readNovaToolMetadata(props.providerMetadata);
  const kind = meta?.kind ?? "other";
  const target = meta?.target || readToolTarget(props.args);
  const hasError = !!props.isError;
  const done = props.result !== undefined;
  const statusText = done ? (hasError ? "失败" : "完成") : "进行中";
  const Icon = TOOL_ICONS[kind];
  const output = stringifyToolResult(props.result);

  return (
    <div className="mb-1.5 w-full">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="ui-glass flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-meta text-text-secondary hover:text-text"
      >
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tool" />
        <span className="shrink-0 font-mono">{props.toolName}</span>
        {target && (
          <span
            className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-text-muted"
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
                  : "animate-pulse bg-accent"
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
        <div className="mt-1 w-full space-y-1 border-l-2 border-tool pl-3">
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
          {done && output && (
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
    <div className="mb-2 flex items-start gap-2 rounded-md border border-error bg-error-bg px-3 py-2 text-body-lg text-error">
      <Bug className="mt-0.5 h-4 w-4 shrink-0" />
      {props.data.message}
    </div>
  );
}

function WarningPart(props: DataMessagePartProps<{ message: string }>) {
  return (
    <div className="mb-2 flex items-start gap-2 rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-body-lg text-text-secondary">
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
            nova: { kind: event.kind, target: event.target },
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
): { kind: ToolKind; target: string } | null {
  const nova = metadata?.nova as
    | { kind?: ToolKind; target?: string }
    | undefined;
  if (!nova) return null;
  return {
    kind: nova.kind ?? "other",
    target: nova.target ?? "",
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
