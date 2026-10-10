/**
 * 任务详情抽屉 — 展示单个任务的执行记录
 *
 * 执行中：从 chat store 的实时消息桶读取（流式 delta 持续合并），并自动滚动到底部
 * 已完成：优先复用同一个消息桶（任务跑在本次运行期间时，桶里已是完整历史）；
 *         桶不存在（如应用重启后翻看历史任务）才回落读盘
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { X, Loader2 } from "lucide-react";
import { MessageGroup } from "../MessageList";
import { StreamingIndicator } from "../ui/StreamingIndicator";
import { AgentPill } from "../ui/AgentPill";
import { FolderTypeIcon } from "../ui/FolderTypeIcon";
import { ipc } from "../../lib/ipc";
import { timeAgo } from "../../lib/utils";
import { useChatStore } from "../../stores/chat";
import type { AutomationTask, Message } from "@shared/types";

export function TaskDetailDrawer({ task, onClose }: { task: AutomationTask; onClose: () => void }) {
  const projects = useChatStore((s) => s.projects);
  const agents = useChatStore((s) => s.agents);

  const isRunning = task.status === "running";
  const sessionId = task.sessionId;

  // 实时消息桶：执行期间由流式事件持续累积；已完成的任务若跑在本次运行期间，
  // 桶里也已是完整历史。用 undefined 表示"没有桶"，空数组表示"读过一次且确实为空"。
  const liveMessages = useChatStore((s) =>
    sessionId ? s.messagesBySession[sessionId] : undefined,
  );
  const hasBucket = liveMessages !== undefined;
  const isStreaming = useChatStore((s) =>
    sessionId ? !!s.streamingBySession[sessionId] : false,
  );

  // 仅当桶里没有数据时才会用到读盘结果
  const [historyMessages, setHistoryMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(() => !isRunning && !hasBucket);

  const loadDetail = useCallback(async () => {
    // 桶里已有数据（执行中，或已完成但跑在本次运行期间）：无需读盘。
    // 用 getState 读快照做一次性判断，避免把桶写成依赖导致反复重建重跑。
    if (isRunning || !sessionId || useChatStore.getState().messagesBySession[sessionId]) {
      setLoading(false);
      return;
    }
    try {
      const session = await ipc.getSession(sessionId);
      setHistoryMessages(session?.messages ?? []);
    } finally {
      setLoading(false);
    }
  }, [isRunning, sessionId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // 桶里有数据优先用桶（含已完成但本次运行期间跑过的任务）；否则用读盘结果
  const messages = isRunning || hasBucket ? (liveMessages ?? []) : historyMessages;

  // 执行中自动滚动到底部
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isRunning && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [liveMessages, isRunning]);

  const project = projects.find((p) => p.id === task.projectId);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-bg/40 backdrop-blur-sm" />
      <div
        className="ui-glass-strong relative flex h-full w-[var(--c-layout-drawer)] max-w-[80vw] flex-col border-l border-border-strong shadow-[var(--c-shadow)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 抽屉头 */}
        <div className="flex h-[var(--c-layout-header)] shrink-0 items-center justify-between border-b border-border px-card">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${
              task.status === "completed" ? "bg-success"
              : task.status === "failed" ? "bg-error"
              : "bg-accent animate-pulse"
            }`} />
            <span className="truncate text-body-lg font-medium text-text">任务执行详情</span>
            {isRunning && (
              <span className="text-meta text-accent">实时</span>
            )}
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 任务元信息 */}
        <div className="shrink-0 border-b border-border p-card">
          <p className="mb-2.5 text-body-lg leading-relaxed text-text">{task.prompt}</p>
          <div className="flex flex-wrap items-center gap-2 text-caption">
            {project && (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 text-text-muted">
                <FolderTypeIcon size={12} toneClassName="text-text-muted" />
                {project.name}
              </span>
            )}
            {task.agentId && <AgentPill agents={agents} agentId={task.agentId} />}
            {task.startedAt && (
              <span className="text-text-muted">开始: {timeAgo(task.startedAt)}</span>
            )}
            {task.completedAt && (
              <span className="text-text-muted">
                {task.status === "completed" ? "完成" : "失败"}: {timeAgo(task.completedAt)}
              </span>
            )}
            {task.error && (
              <span className="text-error">{task.error}</span>
            )}
          </div>
        </div>

        {/* 执行记录 */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-card">
          {!isRunning && loading ? (
            <div className="flex items-center gap-2 py-8 text-body-lg text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中…
            </div>
          ) : messages.length === 0 ? (
            <div className="py-8 text-center text-body-lg text-text-muted">
              {sessionId ? "暂无执行记录" : "任务尚未执行或未创建会话"}
            </div>
          ) : (
            <>
              <div className="space-y-4">
                {messages.map((msg) => (
                  <MessageGroup key={msg.id} events={msg.content} isUser={msg.role === "user"} />
                ))}
              </div>
              {isRunning && isStreaming && (
                <div className="mt-2">
                  <StreamingIndicator />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
