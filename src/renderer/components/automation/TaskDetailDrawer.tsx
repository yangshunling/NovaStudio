/**
 * 任务详情抽屉 — 展示单个任务的执行记录
 *
 * 执行中：从 chat store 的实时消息桶读取（流式 delta 持续合并），并自动滚动到底部
 * 已完成：优先复用同一个消息桶（任务跑在本次运行期间时，桶里已是完整历史）；
 *         桶不存在（如应用重启后翻看历史任务）才回落读盘
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { UserRound } from "lucide-react";

import { MessageGroup } from "../chat/MessageList";
import {
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerHeader,
} from "../ui/Drawer";
import { StreamingIndicator } from "../ui/StreamingIndicator";
import { AgentPill } from "../ui/AgentPill";
import { FolderTypeIcon } from "../ui/FolderTypeIcon";
import { ipc } from "../../lib/ipc";
import { timeAgo } from "../../lib/utils";
import { useChatStore } from "../../stores/chat";
import { useEmployeesStore } from "../../stores/employees";
import type { AutomationTask, Message } from "@shared/types";
import { Spinner } from "../ui/Spinner";

export function TaskDetailDrawer({ task, onClose }: { task: AutomationTask; onClose: () => void }) {
  const projects = useChatStore((s) => s.projects);
  const agents = useChatStore((s) => s.agents);
  const employees = useEmployeesStore((s) => s.employees);
  const employee = task.employeeId
    ? employees.find((item) => item.id === task.employeeId)
    : null;

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
    } catch (err) {
      // 读取失败保留空态，但不能产生未处理的 Promise rejection
      console.warn("[automation] 任务执行记录读取失败：", err);
    } finally {
      setLoading(false);
    }
  }, [isRunning, sessionId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // 桶里有数据优先用桶（含已完成但本次运行期间跑过的任务）；否则用读盘结果
  const messages = isRunning || hasBucket ? (liveMessages ?? []) : historyMessages;

  /*
   * 执行中自动跟随到底部，但用户上翻后暂停跟随：
   * 长输出时强行吸底会让用户无法回看前面的工具调用或错误。
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      const nearBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      stickToBottom.current = nearBottom;
      setFollowing(nearBottom);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!isRunning || !stickToBottom.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [liveMessages, isRunning]);

  const project = projects.find((p) => p.id === task.projectId);

  return (
    <Drawer onClose={onClose} ariaLabel="任务执行详情">
      {/* 抽屉头 */}
      <DrawerHeader>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            task.status === "completed" ? "bg-success"
            : task.status === "failed" ? "bg-error"
            : "bg-accent animate-pulse"
          }`} />
          <span className="truncate ui-type-item font-medium text-text">任务执行详情</span>
          {isRunning && (
            <span className="ui-type-note text-accent">实时</span>
          )}
        </div>
        <DrawerCloseButton onClose={onClose} />
      </DrawerHeader>

      {/* 任务元信息 */}
      <div className="shrink-0 border-b border-border px-section py-card">
          <p className="mb-2.5 ui-type-item leading-relaxed text-text">{task.prompt}</p>
          <div className="flex flex-wrap items-center gap-2 ui-type-sub">
            {project && (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 text-text-muted">
                <FolderTypeIcon size={12} />
                {project.name}
              </span>
            )}
            {task.agentId && <AgentPill agents={agents} agentId={task.agentId} />}
            {employee && (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 text-text-muted">
                <UserRound className="h-3 w-3" />
                {employee.name}
              </span>
            )}
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
      <DrawerBody ref={scrollRef}>
          {!isRunning && loading ? (
            <div className="flex items-center gap-2 py-8 ui-type-item text-text-muted">
              <Spinner className="h-4 w-4" />
              加载中…
            </div>
          ) : messages.length === 0 ? (
            <div className="py-8 text-center ui-type-item text-text-muted">
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
        </DrawerBody>
        {!following && (
          <button
            type="button"
            onClick={() => {
              stickToBottom.current = true;
              setFollowing(true);
              const element = scrollRef.current;
              if (element) element.scrollTop = element.scrollHeight;
            }}
            className="ui-glass-strong ui-ring absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full px-3 py-1.5 ui-type-note text-text-secondary shadow-[var(--c-shadow-sm)] transition-colors hover:text-text"
          >
            回到最新
          </button>
        )}
    </Drawer>
  );
}
