/**
 * 消息渲染共享组件
 *
 * 统一 ChatArea（对话区）和 TaskDetailDrawer（自动化详情抽屉）的消息展示。
 *
 * 组件层级：
 *   MessageGroup（对外导出）
 *     ├─ 用户消息：右对齐气泡
 *     └─ 助手消息：groupAssistantEvents 配对后渲染
 *          ├─ ToolGroupBlock（工具调用 call + result 配对，可折叠）
 *          ├─ StandaloneResultBlock（未配对的独立 tool_result）
 *          └─ EventBlock（text / thinking / error）
 *
 * 工具调用只消费事件里的 kind / target —— 工具名与参数形状的知识在 provider 侧，
 * 本文件不认识任何具体工具。
 */

import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Wrench,
  Bug,
  AlertTriangle,
  ChevronRight,
  FileText,
  PenLine,
  Terminal,
  Search,
  type LucideIcon,
} from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { StreamingIndicator } from "./ui/StreamingIndicator";
import { truncateHead, truncateText, isToolResultError, firstText } from "../lib/utils";
import type { AgentEvent, ToolKind } from "@shared/types";

// ============================================================================
// 类型定义
// ============================================================================

interface ToolGroup {
  kind: "tool";
  call: Extract<AgentEvent, { type: "tool_call" }>;
  result: Extract<AgentEvent, { type: "tool_result" }> | null;
}
interface StandaloneResult {
  kind: "result";
  ev: Extract<AgentEvent, { type: "tool_result" }>;
}
interface PlainEvent {
  kind: "event";
  ev: AgentEvent;
}
type RenderItem = ToolGroup | StandaloneResult | PlainEvent;

// ============================================================================
// 工具函数
// ============================================================================

/** 把 assistant 消息的事件数组按工具调用配对成渲染项 */
function groupAssistantEvents(events: AgentEvent[]): RenderItem[] {
  const items: RenderItem[] = [];
  for (const ev of events) {
    if (ev.type === "tool_call") {
      items.push({ kind: "tool", call: ev, result: null });
    } else if (ev.type === "tool_result") {
      let matched = false;
      for (let j = items.length - 1; j >= 0; j--) {
        const it = items[j];
        if (it.kind === "tool" && !it.result && it.call.name === ev.name) {
          it.result = ev;
          matched = true;
          break;
        }
      }
      if (!matched) items.push({ kind: "result", ev });
    } else {
      items.push({ kind: "event", ev });
    }
  }
  return items;
}

/** 分类 → 图标 */
const TOOL_ICONS: Record<ToolKind, LucideIcon> = {
  read: FileText,
  write: PenLine,
  exec: Terminal,
  search: Search,
  other: Wrench,
};

/**
 * 操作对象的呈现形式：exec 显示命令、search 显示检索词、其余按路径缩短。
 * provider 只给原文，怎么截断/缩短由这里决定。
 */
function toolTarget(call: Extract<AgentEvent, { type: "tool_call" }>): string {
  const raw = call.target;
  if (!raw) return "";
  switch (call.kind) {
    case "exec":
      return truncateHead(raw, 48);
    case "search":
      return `"${truncateHead(raw, 24)}"`;
    default:
      return shortenPath(raw);
  }
}

/** 路径缩短：统一分隔后取末尾最多 3 段 */
function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 3) return parts.join("/");
  return ".../" + parts.slice(-3).join("/");
}

// ============================================================================
// 工具调用块（call + result 配对，紧凑单行，默认折叠）
// ============================================================================

function ToolGroupBlock({ group }: { group: ToolGroup }) {
  const [collapsed, setCollapsed] = useState(true);
  const { call, result } = group;
  const hasError = !!result && isToolResultError(result);
  const status = result ? (hasError ? "failed" : "ok") : "running";
  const statusText = status === "ok" ? "完成" : status === "failed" ? "失败" : "进行中";
  const dotClass =
    status === "ok" ? "bg-success"
    : status === "failed" ? "bg-error"
    : "bg-accent animate-pulse";
  const target = toolTarget(call);
  const fullTarget = call.target || target;
  const Icon = TOOL_ICONS[call.kind];

  return (
    <div className="mb-1.5 max-w-fit">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="ui-glass flex items-center gap-2 rounded-md px-2.5 py-1 text-meta text-text-secondary hover:text-text"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-tool" />
        <span className="shrink-0 font-mono">{call.name}</span>
        {target && (
          <span className="max-w-[280px] truncate font-mono text-text-muted" title={fullTarget}>
            {target}
          </span>
        )}
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
        <span className={`shrink-0 ${hasError ? "text-error" : "text-text-muted"}`}>{statusText}</span>
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-text-muted transition-transform ${collapsed ? "" : "rotate-90"}`}
        />
      </button>
      {!collapsed && (
        <div className="mt-1 space-y-1 border-l-2 border-tool pl-3">
          <div>
            <div className="text-micro uppercase tracking-wide text-text-muted">input</div>
            <pre className="ui-glass max-h-40 overflow-auto rounded-md px-2 py-1 text-meta text-text-secondary">
              {truncateText(JSON.stringify(call.input, null, 2), 500)}
            </pre>
          </div>
          {result && result.output && (
            <div>
              <div className="text-micro uppercase tracking-wide text-text-muted">
                {hasError ? "error" : "output"}
              </div>
              <pre
                className={`ui-glass max-h-48 overflow-auto rounded-md px-2 py-1 text-meta ${hasError ? "text-error" : "text-text-muted"}`}
              >
                {truncateText(result.output, 500)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StandaloneResultBlock({ item }: { item: StandaloneResult }) {
  const hasError = isToolResultError(item.ev);
  return (
    <div className="mb-1.5 flex items-center gap-2 text-meta text-text-muted">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${hasError ? "bg-error" : "bg-success"}`} />
      <span className="font-mono">{item.ev.name}</span>
      <span>{hasError ? "失败" : "完成"}</span>
    </div>
  );
}

// ============================================================================
// 单个事件渲染
// ============================================================================

function EventBlock({ event }: { event: AgentEvent }) {
  const [collapsed, setCollapsed] = useState(false);
  /**
   * 思考块自带独立滚动条（max-h-60）：流式输出时若不自动跟随，
   * 新内容会落在可视区下方，用户必须手动滚动才能看到。
   * 采用「贴近底部才跟随」策略 —— 用户主动往上翻阅时不被拉回。
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [event]);

  const handleBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  switch (event.type) {
    case "thinking":
      return (
        <div className="group mb-3 max-w-fit">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex w-full items-center gap-2 text-meta text-thinking hover:text-text-secondary"
          >
            <Brain className="h-3.5 w-3.5" />
            <span className="ui-serif">思考</span>
            <ChevronRight
              className={`h-3 w-3 text-text-muted transition-transform ${collapsed ? "" : "rotate-90"}`}
            />
          </button>
          {!collapsed && (
            <div
              ref={bodyRef}
              onScroll={handleBodyScroll}
              className="mt-2 max-h-60 overflow-auto rounded-md border-l-4 border-thinking bg-thinking-bg px-4 py-3 text-text-secondary backdrop-blur-md"
            >
              <MarkdownRenderer content={event.content} />
            </div>
          )}
        </div>
      );

    case "error":
      return (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-error bg-error-bg px-3 py-2 text-body-lg text-error backdrop-blur-sm">
          <Bug className="mt-0.5 h-4 w-4 shrink-0" />
          {event.message}
        </div>
      );

    // 非致命提示：运行仍在继续，用中性底 + 警示图标与致命错误区分开
    case "warning":
      return (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-body-lg text-text-secondary backdrop-blur-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
          {event.message}
        </div>
      );

    case "text":
      return (
        <div className="mb-2">
          <div className="ui-bubble w-fit max-w-full bg-surface-2 px-4 py-3">
            <MarkdownRenderer content={event.content} />
          </div>
        </div>
      );

    case "done":
      return null;

    default:
      return null;
  }
}

// ============================================================================
// 消息块（user / assistant）— 对外导出
// ============================================================================

export function MessageGroup({ events, isUser }: { events: AgentEvent[]; isUser: boolean }) {
  if (isUser) {
    const text = firstText(events);
    return (
      <div className="mb-4 flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-border-strong bg-bubble-user px-4 py-2.5 text-body-lg text-bubble-user-text shadow-[var(--c-shadow-sm)]">
          {text}
        </div>
      </div>
    );
  }

  const items = groupAssistantEvents(events);
  if (items.length === 0) return null;
  return (
    <div className="mb-4 flex flex-col gap-1">
      {items.map((item, i) => {
        if (item.kind === "tool") return <ToolGroupBlock key={i} group={item} />;
        if (item.kind === "result") return <StandaloneResultBlock key={i} item={item} />;
        return <EventBlock key={i} event={item.ev} />;
      })}
    </div>
  );
}

/** 流式加载指示器 */
export { StreamingIndicator };
