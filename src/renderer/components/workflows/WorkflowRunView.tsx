/**
 * 工作流运行详情
 *
 * 左侧：本次运行的全部节点，点击切换。
 * 右侧：选中节点的状态 + 完整对话过程（不再展示结果、输入、诊断与事件日志）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  FileText,
  FolderOpen,
  Loader2,
  PauseCircle,
  Square,
  X,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toast";
import { appendEvent } from "@shared/merge";
import { MessageGroup } from "../MessageList";
import { formatDateTime, formatDuration } from "../../lib/workflowFormat";
import {
  ACTIVE_RUN_STATUSES,
  NODE_STATUS,
  RUN_STATUS,
} from "../../lib/workflowStatus";
import type {
  AgentEvent,
  WorkflowNodeLiveTranscript,
  WorkflowNodeRun,
  WorkflowNodeRunDetail,
  WorkflowRunDetail,
  WorkflowRunStatus,
} from "@shared/types";

// ============================================================================
// 实时对话缓冲
//
// 主进程按 seq 推送原始事件；节点详情接口同时返回一份快照。
// 两侧可能乱序到达，因此按 seq 去重合并，再按顺序重放 appendEvent。
// ============================================================================

interface LiveItem {
  seq: number;
  event: AgentEvent;
}

interface LiveEntry {
  attempt: number;
  seq: number;
  items: LiveItem[];
  folded: AgentEvent[];
}

type LiveMap = Record<string, LiveEntry>;

/** 与主进程保持一致的事件上限：超出后只保留最近一段，避免长节点吃满内存 */
const MAX_LIVE_EVENTS = 20_000;

/** 按 seq 顺序把原始事件折叠成可渲染的事件流（与聊天页的收敛规则一致） */
function foldLiveItems(items: LiveItem[]): AgentEvent[] {
  const sorted = [...items].sort((a, b) => a.seq - b.seq);
  let events: AgentEvent[] = [];
  for (const item of sorted) events = appendEvent(events, item.event);
  return events;
}

function liveEntryFrom(attempt: number, items: LiveItem[]): LiveEntry {
  let sorted = [...items].sort((a, b) => a.seq - b.seq);
  if (sorted.length > MAX_LIVE_EVENTS) {
    sorted = sorted.slice(-MAX_LIVE_EVENTS);
  }
  return {
    attempt,
    seq: sorted[sorted.length - 1]?.seq ?? 0,
    items: sorted,
    folded: foldLiveItems(sorted),
  };
}

/** 追加一条推送事件 */
function mergeLiveItem(
  prev: LiveMap,
  nodeRunId: string,
  attempt: number,
  item: LiveItem,
): LiveMap {
  const current = prev[nodeRunId];
  if (!current || current.attempt !== attempt) {
    return { ...prev, [nodeRunId]: liveEntryFrom(attempt, [item]) };
  }
  if (item.seq <= current.seq) return prev; // 重复或更旧的事件
  if (item.seq === current.seq + 1) {
    const items = [...current.items, item];
    if (items.length > MAX_LIVE_EVENTS) {
      // 超出上限：只保留最近一段，并保持 seq 与主进程一致
      const entry = liveEntryFrom(attempt, items);
      entry.seq = item.seq;
      return { ...prev, [nodeRunId]: entry };
    }
    return {
      ...prev,
      [nodeRunId]: {
        attempt,
        seq: item.seq,
        items,
        folded: appendEvent(current.folded, item.event),
      },
    };
  }
  // 中间有缺口（快照还没到）：整体重排后重算
  const entry = liveEntryFrom(attempt, [...current.items, item]);
  entry.seq = Math.max(entry.seq, current.seq, item.seq);
  return { ...prev, [nodeRunId]: entry };
}

/** 合并节点详情接口返回的快照（通常是推送的前缀） */
function mergeLiveSnapshot(
  prev: LiveMap,
  nodeRunId: string,
  snapshot: WorkflowNodeLiveTranscript,
): LiveMap {
  const incoming = snapshot.events.map((event, index) => ({
    seq: index + 1,
    event,
  }));
  const current = prev[nodeRunId];
  if (!current || current.attempt !== snapshot.attempt) {
    const entry = liveEntryFrom(snapshot.attempt, incoming);
    // 主进程可能只保留前缀（seq 大于 events.length）：以快照 seq 为准，
    // 后续推送才能连续合并，否则每个事件都会因为“缺口”重新折叠整段历史。
    entry.seq = snapshot.seq;
    return { ...prev, [nodeRunId]: entry };
  }
  const seen = new Set(current.items.map((item) => item.seq));
  const missing = incoming.filter((item) => !seen.has(item.seq));
  if (missing.length === 0) {
    return snapshot.seq > current.seq
      ? { ...prev, [nodeRunId]: { ...current, seq: snapshot.seq } }
      : prev;
  }
  const entry = liveEntryFrom(snapshot.attempt, [...current.items, ...missing]);
  entry.seq = Math.max(current.seq, snapshot.seq, entry.seq);
  return { ...prev, [nodeRunId]: entry };
}

export function WorkflowRunView({
  runId,
  onBack,
}: {
  runId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const [selectedNodeRunId, setSelectedNodeRunId] = useState<string | null>(null);
  const [nodeDetail, setNodeDetail] = useState<WorkflowNodeRunDetail | null>(null);
  const [nodeDetailLoading, setNodeDetailLoading] = useState(false);
  /** nodeRunId → 运行中的实时对话；节点结束后不再展示，以落库消息为准 */
  const [liveMap, setLiveMap] = useState<LiveMap>({});

  const previousStatus = useRef<WorkflowRunStatus | null>(null);

  // ---- 运行详情：初始加载 + 事件增量刷新 ----
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const reload = async () => {
      try {
        const next = await ipc.getWorkflowRun(runId);
        if (!alive) return;
        setDetail(next);
        setError(next ? null : "运行记录不存在");
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    };

    void reload();
    const off = ipc.on.workflowRunEvent((event) => {
      if (event.runId !== runId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), 80);
    });

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [runId]);

  // 运行中每秒刷新耗时
  useEffect(() => {
    if (!detail || !ACTIVE_RUN_STATUSES.has(detail.run.status)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [detail?.run.status]);

  // 结束提示只弹一次
  useEffect(() => {
    const status = detail?.run.status;
    if (!status) return;
    const previous = previousStatus.current;
    previousStatus.current = status;
    if (!previous || previous === status) return;
    if (status === "succeeded") toast.success("工作流运行完成");
    else if (status === "failed")
      toast.error(detail?.run.error || "工作流运行失败", 5000);
    else if (status === "canceled") toast.info("工作流已取消");
    else if (status === "interrupted") toast.error("应用退出，运行被中断");
  }, [detail?.run.status, detail?.run.error]);

  const nodes = detail?.nodes ?? [];

  // 默认选中第一个节点；节点消失时回退
  useEffect(() => {
    if (nodes.length === 0) {
      if (selectedNodeRunId) setSelectedNodeRunId(null);
      return;
    }
    if (!nodes.some((node) => node.id === selectedNodeRunId)) {
      setSelectedNodeRunId(nodes[0].id);
    }
  }, [nodes, selectedNodeRunId]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeRunId) ?? null,
    [nodes, selectedNodeRunId],
  );

  /** 选中节点正在执行时的实时事件流；结束后改用落库消息 */
  const selectedLiveEvents = useMemo(() => {
    if (!selectedNode) return null;
    if (
      selectedNode.status !== "running" &&
      selectedNode.status !== "retrying"
    ) {
      return null;
    }
    const entry = liveMap[selectedNode.id];
    if (!entry || entry.attempt !== selectedNode.attempt) return null;
    return entry.folded.length > 0 ? entry.folded : null;
  }, [liveMap, selectedNode]);

  // 节点详情：随选中节点或该节点状态变化重新读取
  useEffect(() => {
    if (!selectedNodeRunId) {
      setNodeDetail(null);
      return;
    }
    let alive = true;
    setNodeDetailLoading(true);
    void ipc
      .getWorkflowNodeDetail(runId, selectedNodeRunId)
      .then((next) => {
        if (!alive) return;
        setNodeDetail(next);
        // 中途打开运行记录时，先用主进程内存里的快照补齐已产生的对话，
        // 后续增量由推送按 seq 合并。
        if (next?.live) {
          setLiveMap((prev) =>
            mergeLiveSnapshot(prev, selectedNodeRunId, next.live!),
          );
        }
      })
      .catch(() => {
        if (alive) setNodeDetail(null);
      })
      .finally(() => {
        if (alive) setNodeDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [runId, selectedNodeRunId, selectedNode?.status]);

  // 节点执行中的实时事件：只按 seq 合并，不做节流（主进程已按 16ms 聚合）
  useEffect(() => {
    setLiveMap({});
    const off = ipc.on.workflowRunAgentEvent((payload) => {
      if (payload.runId !== runId) return;
      setLiveMap((prev) =>
        mergeLiveItem(prev, payload.nodeRunId, payload.attempt, {
          seq: payload.seq,
          event: payload.event,
        }),
      );
    });
    return off;
  }, [runId]);

  const awaitingNode = useMemo(
    () => nodes.find((node) => node.status === "awaiting_approval"),
    [nodes],
  );

  const awaitingConfig = useMemo(() => {
    if (!detail || !awaitingNode) return null;
    return detail.run.graph.nodes.find((node) => node.id === awaitingNode.nodeId) ?? null;
  }, [detail, awaitingNode]);

  const decide = async (action: "approve" | "reject") => {
    if (!awaitingNode || busy) return;
    setBusy(true);
    try {
      await ipc.approveWorkflowNode(runId, awaitingNode.id, action);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cancelRun = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await ipc.cancelWorkflowRun(runId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <main className="relative flex flex-1 items-center justify-center overflow-hidden">
        <div className="relative z-10 flex items-center gap-2 text-body text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在读取运行记录
        </div>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="relative flex flex-1 flex-col items-center justify-center gap-3 overflow-hidden">
        <p className="relative z-10 text-body text-error">{error ?? "运行记录不存在"}</p>
        <button
          type="button"
          onClick={onBack}
          className="ui-btn-ghost relative z-10 rounded-lg px-3 py-2 text-meta"
        >
          返回
        </button>
      </main>
    );
  }

  const { run } = detail;
  const statusMeta = RUN_STATUS[run.status];
  const StatusIcon = statusMeta.icon;
  const active = ACTIVE_RUN_STATUSES.has(run.status);
  const elapsed = formatDuration(run.startedAt, run.finishedAt, now);
  const doneCount = nodes.filter(
    (node) => node.status === "succeeded" || node.status === "skipped",
  ).length;

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <div className="ui-page relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center gap-3 border-b border-border px-4">
          <button
            type="button"
            onClick={onBack}
            title="返回运行记录"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-body text-text-muted transition-colors hover:bg-surface-hover hover:text-text active:scale-95"
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </button>

          <span className="h-5 w-px shrink-0 bg-border" />

          <div className="min-w-0">
            <p className="truncate text-heading font-semibold text-text">
              {run.workflowName}
            </p>
            <p className="truncate font-mono text-caption text-text-muted">
              运行 #{run.id.slice(0, 8)} · {run.workspacePath}
            </p>
          </div>

          <span
            className={`ml-1 flex shrink-0 items-center gap-1.5 rounded-full bg-surface-hover px-2.5 py-1 text-meta font-medium ${statusMeta.className}`}
          >
            <StatusIcon
              className={`h-3.5 w-3.5 ${active ? "animate-spin" : ""}`}
            />
            {statusMeta.label}
          </span>

          <span className="shrink-0 font-mono text-meta text-text-muted">
            {elapsed}
          </span>
          <span className="shrink-0 text-meta text-text-muted">
            {doneCount}/{nodes.length} 节点
          </span>

          <div className="min-w-0 flex-1" />

          {run.error && (
            <span className="max-w-64 truncate text-meta text-error" title={run.error}>
              {run.error}
            </span>
          )}

          <button
            type="button"
            onClick={async () => {
              const ok = await ipc.openWorkflowArtifacts(runId);
              if (!ok) toast.error("无法打开产物目录");
            }}
            className="ui-btn-ghost flex h-8 shrink-0 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95"
          >
            <FolderOpen className="h-4 w-4" />
            产物
          </button>

          {active && (
            <button
              type="button"
              onClick={() => void cancelRun()}
              disabled={busy}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-error/40 bg-error-bg px-4 text-body font-medium text-error transition-colors hover:border-error active:scale-95 disabled:opacity-50"
            >
              <Square className="h-3.5 w-3.5" />
              终止
            </button>
          )}
        </header>

        <div className="flex min-h-0 flex-1">
          {/* 左：节点列表 */}
          <aside className="flex w-[300px] shrink-0 flex-col border-r border-border bg-[var(--c-panel-bg)]">
            <div className="flex items-center justify-between px-4 pb-2 pt-4">
              <p className="text-meta font-semibold tracking-wide text-text-muted">
                节点
              </p>
              <span className="font-mono text-caption text-text-muted">
                {doneCount}/{nodes.length}
              </span>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-4">
              {nodes.map((node) => (
                <NodeListItem
                  key={node.id}
                  node={node}
                  active={node.id === selectedNodeRunId}
                  now={now}
                  onClick={() => setSelectedNodeRunId(node.id)}
                />
              ))}
              {nodes.length === 0 && (
                <p className="px-1 py-2 text-meta text-text-muted">
                  本次运行没有可执行节点。
                </p>
              )}
            </div>
          </aside>

          {/* 右：选中节点详情 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {awaitingNode && awaitingConfig && (
                <section className="mb-4 rounded-xl border border-accent/40 bg-accent-soft p-4">
                  <div className="flex items-center gap-2">
                    <PauseCircle className="h-4 w-4 shrink-0 text-accent" />
                    <p className="text-body-lg font-semibold text-text">
                      等待人工审核 · {awaitingNode.nodeName}
                    </p>
                    <span className="rounded-full bg-surface/60 px-2 py-0.5 text-caption text-text-secondary">
                      {awaitingNode.employeeName}
                    </span>
                  </div>
                  <p className="mt-2 text-meta text-text-secondary">
                    通过后才会把任务详情交给数字员工执行。
                  </p>
                  {awaitingConfig.config.taskDetail && (
                    <pre className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface/60 p-3 font-sans text-body leading-relaxed text-text">
                      {awaitingConfig.config.taskDetail}
                    </pre>
                  )}
                  <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => void decide("reject")}
                      disabled={busy}
                      className="ui-btn-ghost flex h-8 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95 disabled:opacity-50"
                    >
                      <X className="h-4 w-4" />
                      驳回
                    </button>
                    <button
                      type="button"
                      onClick={() => void decide("approve")}
                      disabled={busy}
                      className="ui-btn-primary flex h-8 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95 disabled:opacity-50"
                    >
                      <Check className="h-4 w-4" />
                      通过
                    </button>
                  </div>
                </section>
              )}

              {selectedNode ? (
                <NodeDetailPanel
                  node={selectedNode}
                  detail={nodeDetail}
                  loading={nodeDetailLoading}
                  now={now}
                  live={selectedLiveEvents}
                />
              ) : (
                <div className="flex flex-col items-center gap-2 py-16 text-center text-text-muted">
                  <FileText className="h-5 w-5 opacity-50" />
                  <p className="text-body">左侧选择一个节点查看执行详情</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

// ============================================================================
// 左侧节点项
// ============================================================================

function NodeListItem({
  node,
  active,
  now,
  onClick,
}: {
  node: WorkflowNodeRun;
  active: boolean;
  now: number;
  onClick: () => void;
}) {
  const meta = NODE_STATUS[node.status];
  const Icon = meta.icon;
  const spinning = node.status === "running" || node.status === "retrying";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${
        active
          ? "bg-surface-active text-text"
          : "text-text-secondary hover:bg-surface-hover hover:text-text"
      }`}
    >
      <Icon
        className={`mt-0.5 h-4 w-4 shrink-0 ${meta.className} ${
          spinning ? "animate-spin" : ""
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-body-lg font-medium">{node.nodeName}</span>
          <span className={`shrink-0 text-caption ${meta.className}`}>
            {meta.label}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-meta text-text-muted">
          {node.employeeName ?? "未绑定员工"}
          {node.attempt > 1 ? ` · 第 ${node.attempt} 次` : ""} ·{" "}
          {formatDuration(node.startedAt, node.finishedAt, now)}
        </span>
      </span>
    </button>
  );
}

// ============================================================================
// 节点详情
// ============================================================================

function NodeDetailPanel({
  node,
  detail,
  loading,
  now,
  live,
}: {
  node: WorkflowNodeRun;
  detail: WorkflowNodeRunDetail | null;
  loading: boolean;
  now: number;
  /** 节点执行中的实时事件流；不在运行时为 null */
  live: AgentEvent[] | null;
}) {
  const meta = NODE_STATUS[node.status];
  const attempts = detail?.attempts ?? [];
  const hasConversation =
    attempts.some((attempt) => attempt.messages.length > 0) ||
    (live?.length ?? 0) > 0;

  return (
    <div className="space-y-3">
      {/* 基本信息 */}
      <section className="rounded-xl border border-border bg-surface-2/50 p-3.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className={`flex items-center gap-1.5 text-body-lg font-semibold ${meta.className}`}>
            {meta.label}
          </span>
          <span className="text-meta text-text-secondary">
            执行者：{node.employeeName ?? "—"}
          </span>
          <span className="text-meta text-text-secondary">
            Agent：{node.agentId ?? "—"}
          </span>
          <span className="text-meta text-text-secondary">
            尝试：第 {node.attempt} 次
          </span>
        </div>

        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-meta text-text-muted">
          <span>开始：{formatDateTime(node.startedAt)}</span>
          <span>完成：{formatDateTime(node.finishedAt)}</span>
          <span>
            耗时：{formatDuration(node.startedAt, node.finishedAt, now)}
          </span>
        </div>

        {node.error && (
          <p className="mt-2 rounded-lg bg-error-bg px-2.5 py-2 text-meta leading-relaxed text-error">
            {node.error}
          </p>
        )}
      </section>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-body text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在读取节点详情
        </div>
      ) : !hasConversation ? (
        <p className="py-10 text-center text-meta italic text-text-muted">
          （还没有记录到对话）
        </p>
      ) : (
        <div className="space-y-4">
          {attempts.map((attempt) =>
            attempt.messages.map((message) => (
              <MessageGroup
                key={message.id}
                events={message.content}
                isUser={message.role === "user"}
              />
            )),
          )}
          {live && live.length > 0 && (
            <MessageGroup events={live} isUser={false} />
          )}
        </div>
      )}
    </div>
  );
}
