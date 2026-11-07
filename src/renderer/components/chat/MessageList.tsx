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
 * 工具调用只消费事件里的 kind / target / lineStarts —— 工具名与参数形状的知识
 * 在 provider 侧，本文件不认识任何具体工具。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  Bug,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { StreamingIndicator } from "../ui/StreamingIndicator";
import { UserBubble } from "../ui/UserBubble";
import { isToolResultError, firstText } from "../../lib/utils";
import { extractFileChanges } from "../../lib/tool-diff";
import { ToolCallCard } from "./ToolCallCard";
import type { AgentEvent } from "@shared/types";

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
        const sameCall =
          ev.callId && it.kind === "tool" && it.call.callId
            ? ev.callId === it.call.callId
            : it.kind === "tool" && it.call.name === ev.name;
        if (it.kind === "tool" && !it.result && sameCall) {
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

// ============================================================================
// 工具调用块（call + result 配对，与实时对话共用同一张卡片）
// ============================================================================

function ToolGroupBlock({ group }: { group: ToolGroup }) {
  const { call, result } = group;
  const hasError = !!result && isToolResultError(result);
  const changes = useMemo(
    () => extractFileChanges(call.name, call.input, call.kind, call.lineStarts),
    [call.name, call.input, call.kind, call.lineStarts],
  );

  return (
    <div className="mb-1.5 w-full">
      <ToolCallCard
        toolName={call.name}
        target={call.target || ""}
        kind={call.kind}
        args={call.input}
        result={result ? result.output : undefined}
        isError={hasError}
        running={!result}
        changes={changes}
      />
    </div>
  );
}

function StandaloneResultBlock({ item }: { item: StandaloneResult }) {
  const hasError = isToolResultError(item.ev);
  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-border/50 bg-surface-2/30 px-3 py-1.5 text-meta text-text-muted">
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          hasError ? "bg-error" : "bg-success"
        }`}
      />
      <span className="font-mono">{item.ev.name}</span>
      <span>{hasError ? "失败" : "完成"}</span>
    </div>
  );
}

// ============================================================================
// 单个事件渲染
// ============================================================================

function EventBlock({ event }: { event: AgentEvent }) {
  const [collapsed, setCollapsed] = useState(true);
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
        <div className="mb-2 max-w-full overflow-hidden rounded-xl border border-border/60 bg-surface-2/30">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-meta text-thinking transition-colors hover:bg-surface-hover/40 hover:text-text-secondary"
          >
            <Brain className="h-3.5 w-3.5 shrink-0" />
            <span>思考过程</span>
            <ChevronRight
              className={`ml-auto h-3 w-3 text-text-muted transition-transform ${collapsed ? "" : "rotate-90"}`}
            />
          </button>
          {!collapsed && (
            <div
              ref={bodyRef}
              onScroll={handleBodyScroll}
              className="max-h-60 overflow-auto border-t border-border/50 bg-thinking-bg/60 px-3.5 py-2.5 text-text-secondary"
            >
              <MarkdownRenderer content={event.content} />
            </div>
          )}
        </div>
      );

    case "error":
      return (
        <div className="mb-2 flex items-start gap-2.5 rounded-xl border border-error/30 bg-error-bg/70 px-3.5 py-2.5 text-body text-error">
          <Bug className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0">{event.message}</span>
        </div>
      );

    // 非致命提示：运行仍在继续，用中性底 + 警示图标与致命错误区分开
    case "warning":
      return (
        <div className="mb-2 flex items-start gap-2.5 rounded-xl border border-border/60 bg-surface-2/40 px-3.5 py-2.5 text-body text-text-secondary">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
          <span className="min-w-0">{event.message}</span>
        </div>
      );

    case "text":
      return (
        <div className="mb-2">
          <div className="ui-bubble w-fit max-w-full bg-surface-2/60 px-4 py-3.5">
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
        <UserBubble>{text}</UserBubble>
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
