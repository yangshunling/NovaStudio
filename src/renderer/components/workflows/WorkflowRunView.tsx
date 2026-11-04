/**
 * 工作流运行详情
 *
 * 左侧：本次运行的全部节点，点击切换。
 * 右侧：选中节点的状态 + 完整对话过程（不再展示结果、输入、诊断与事件日志）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  FileText,
  FolderOpen,
  Loader2,
  PauseCircle,
  RotateCw,
  Square,
  X,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import { appendEvent } from "@shared/merge";
import { MessageGroup } from "../MessageList";
import {
  formatDateTime,
  formatDuration,
  formatSize,
} from "../../lib/workflowFormat";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { EmptyState, LoadingState } from "../ui/EmptyState";
import { Page } from "../ui/Page";
import { SegmentedTabs } from "../ui/SegmentedTabs";
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
  const [approvalNotes, setApprovalNotes] = useState<Record<string, string>>({});

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
    // interrupted 有两种来源：应用退出、人工审核超时。原因以后端记录为准
    else if (status === "interrupted")
      toast.error(detail?.run.error || "运行被中断，可稍后继续", 5000);
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

  /*
   * 详情区随实时 token 增长：贴近底部时自动跟随，用户上翻后暂停跟随。
   * 否则新内容一直追加在可视区下方，用户必须手动滚动才能看到最新输出。
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /** 切换节点时重新开启跟随，否则继承上一个节点的“已上翻”状态 */
  const followedNodeId = useRef<string | null>(null);
  useEffect(() => {
    if (followedNodeId.current !== selectedNodeRunId) {
      followedNodeId.current = selectedNodeRunId;
      stickToBottom.current = true;
    }
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [selectedLiveEvents, nodeDetail, selectedNodeRunId]);
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

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

  /** DAG 并行执行时可能有多个节点同时等待审核 */
  const awaitingNodes = useMemo(
    () => nodes.filter((node) => node.status === "awaiting_approval"),
    [nodes],
  );

  /**
   * 人工驳回意味着产物本身不合格，整条运行就此终止（主进程也会拒绝续跑）。
   * 界面必须同步：不能让用户点一个注定报错的「继续运行」。
   */
  const rejectedNode = useMemo(
    () => nodes.find((node) => node.decision === "rejected") ?? null,
    [nodes],
  );
  const canResumeRun = !rejectedNode;

  const decide = async (
    target: WorkflowNodeRun,
    action: "approve" | "reject",
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      const handled = await ipc.approveWorkflowNode(
        runId,
        target.id,
        action,
        (approvalNotes[target.id] ?? "").trim() || undefined,
      );
      // 主进程返回 false：这条审批已失效（运行已结束或被另一处处理过）
      if (!handled) {
        toast.error("该审核已失效：运行可能已结束或在别处处理过，请刷新后查看", 5000);
        return;
      }
      setApprovalNotes((current) => ({ ...current, [target.id]: "" }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** 从指定节点（默认第一个失败节点）继续执行；会重置该节点及下游 */
  const resumeRun = async (nodeRunId?: string) => {
    if (busy) return;
    const confirmed = await confirmDialog({
      title: nodeRunId ? "从该节点继续执行？" : "继续执行这次运行？",
      message: nodeRunId
        ? "会重置该节点及全部下游的状态并重新执行；上游节点的结果保留。"
        : "会自动选择第一个失败或未完成的节点，重置它及全部下游后重新执行。",
      confirmLabel: "继续执行",
      cancelLabel: "取消",
    });
    if (!confirmed) return;

    setBusy(true);
    try {
      await ipc.resumeWorkflowRun(runId, nodeRunId);
      toast.success("已开始继续执行");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 5000);
    } finally {
      setBusy(false);
    }
  };

  const cancelRun = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const handled = await ipc.cancelWorkflowRun(runId);
      // false：运行已经结束（可能在另一个窗口处理过），提示刷新而不是静默成功
      if (!handled) toast.error("该运行已结束，无需终止", 4000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Page>
        <LoadingState text="正在读取运行记录" className="h-full" />
      </Page>
    );
  }

  if (!detail) {
    return (
      <Page>
        <EmptyState
          icon={<FileText />}
          title={error ?? "运行记录不存在"}
          action={
            <Button variant="ghost" size="sm" onClick={onBack}>
              返回
            </Button>
          }
        />
      </Page>
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
    <Page>
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center gap-3 border-b border-border px-4">
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft className="h-4 w-4" />}
            onClick={onBack}
            title="返回运行记录"
          >
            返回
          </Button>

          <span className="h-5 w-px shrink-0 bg-border" />

          <div className="min-w-0">
            <p className="ui-serif truncate text-title font-semibold tracking-wide text-text-secondary">
              {run.workflowName}
            </p>
            <p className="truncate font-mono text-caption text-text-muted">
              运行 #{run.id.slice(0, 8)} ·{" "}
              {run.source === "trigger"
                ? `触发器${run.triggerId ? ` ${run.triggerId.slice(0, 8)}` : ""}`
                : "手动"}{" "}
              · {run.workspacePath}
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

          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 rounded-full"
            icon={<FolderOpen className="h-4 w-4" />}
            onClick={async () => {
              const ok = await ipc.openWorkflowArtifacts(runId);
              if (!ok) toast.error("无法打开产物目录");
            }}
          >
            产物
          </Button>

          {active && (
            <Button
              variant="dangerSoft"
              size="sm"
              className="shrink-0 rounded-full"
              icon={<Square className="h-3.5 w-3.5" />}
              onClick={() => void cancelRun()}
              disabled={busy}
            >
              终止
            </Button>
          )}

          {!active &&
            canResumeRun &&
            (run.status === "failed" ||
              run.status === "canceled" ||
              run.status === "interrupted") && (
              <Button
                variant="primary"
                size="sm"
                className="shrink-0 rounded-full"
                icon={<RotateCw className="h-3.5 w-3.5" />}
                onClick={() => void resumeRun()}
                disabled={busy}
              >
                继续运行
              </Button>
            )}
        </header>

        {rejectedNode && (
          <div className="flex items-start gap-2 border-b border-border bg-agent-amber/10 px-4 py-2.5 text-meta text-text-secondary">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-agent-amber" />
            <span>
              节点「{rejectedNode.nodeName}」已被人工驳回，本次运行已终止且不能继续执行。
              请修改工作流（或重新发起一次运行）后重试。
            </span>
          </div>
        )}

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
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="min-h-0 flex-1 overflow-y-auto p-4"
            >
              {awaitingNodes.map((awaitingNode) => {
                const note = approvalNotes[awaitingNode.id] ?? "";
                return (
                  <section
                    key={awaitingNode.id}
                    className="mb-4 rounded-xl border border-accent/40 bg-accent-soft p-4"
                  >
                    <div className="flex items-center gap-2">
                      <PauseCircle className="h-4 w-4 shrink-0 text-accent" />
                      <p className="text-body-lg font-semibold text-text">
                        产物待审核 · {awaitingNode.nodeName}
                      </p>
                      <span className="rounded-full bg-surface/60 px-2 py-0.5 text-caption text-text-secondary">
                        {awaitingNode.employeeName}
                      </span>
                    </div>
                    <p className="mt-2 text-meta text-text-secondary">
                      节点已执行完成，请确认产物。通过则节点完成并继续下游；
                      驳回会立即终止本次运行，且不能重试。
                    </p>
                    {awaitingNode.outputSummary && (
                      <pre className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface/60 p-3 font-sans text-body leading-relaxed text-text">
                        {awaitingNode.outputSummary}
                      </pre>
                    )}
                    <p className="mt-2 text-caption text-text-muted">
                      完整产物与对话见下方节点详情
                      {awaitingNode.outputPath ? `（${awaitingNode.nodeName} · result.md）` : ""}
                    </p>
                    <textarea
                      value={note}
                      onChange={(event) =>
                        setApprovalNotes((current) => ({
                          ...current,
                          [awaitingNode.id]: event.target.value,
                        }))
                      }
                      rows={2}
                      placeholder="审核备注（驳回时建议填写原因，会写入节点历史）"
                      className="ui-ring mt-3 w-full resize-none rounded-lg bg-surface/60 px-3 py-2 text-meta text-text placeholder-text-muted outline-none"
                    />
                    <div className="mt-3 flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full"
                        icon={<X className="h-4 w-4" />}
                        onClick={() => void decide(awaitingNode, "reject")}
                        disabled={busy}
                      >
                        驳回
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        className="rounded-full"
                        icon={<Check className="h-4 w-4" />}
                        onClick={() => void decide(awaitingNode, "approve")}
                        disabled={busy}
                      >
                        通过
                      </Button>
                    </div>
                  </section>
                );
              })}

              {selectedNode ? (
                <NodeDetailPanel
                  runId={runId}
                  node={selectedNode}
                  detail={nodeDetail}
                  loading={nodeDetailLoading}
                  now={now}
                  live={selectedLiveEvents}
                  canResume={!active && canResumeRun}
                  onResume={() => void resumeRun(selectedNode.id)}
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
    </Page>
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

type NodeDetailTab =
  | "conversation"
  | "result"
  | "artifacts"
  | "notices"
  | "execution";

function NodeDetailPanel({
  runId,
  node,
  detail,
  loading,
  now,
  live,
  canResume,
  onResume,
}: {
  runId: string;
  node: WorkflowNodeRun;
  detail: WorkflowNodeRunDetail | null;
  loading: boolean;
  now: number;
  /** 节点执行中的实时事件流；不在运行时为 null */
  live: AgentEvent[] | null;
  /** 运行已结束时可从该节点继续 */
  canResume: boolean;
  onResume: () => void;
}) {
  const [tab, setTab] = useState<NodeDetailTab>("conversation");
  const [preview, setPreview] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  // 切换节点时回到对话页，避免停在“结果/产物”看到空内容
  useEffect(() => {
    setTab("conversation");
    setPreview(null);
  }, [node.id]);
  const meta = NODE_STATUS[node.status];
  const attempts = detail?.attempts ?? [];
  const files = detail?.files ?? [];
  const notices = detail?.notices ?? [];
  const hasConversation =
    attempts.some((attempt) => attempt.messages.length > 0) ||
    (live?.length ?? 0) > 0;

  const openFile = async (relativePath: string) => {
    const ok = await ipc.openWorkflowNodeFile(runId, node.id, relativePath);
    if (!ok) toast.error("无法打开产物文件");
  };

  const openDir = async () => {
    const ok = await ipc.openWorkflowNodeArtifacts(runId, node.id);
    if (!ok) toast.error("无法打开产物目录");
  };

  const previewFile = async (relativePath: string) => {
    setPreviewLoading(relativePath);
    try {
      const content = await ipc.readWorkflowNodeFile(
        runId,
        node.id,
        relativePath,
      );
      if (content === null) {
        toast.error("无法预览该文件（可能不是文本或文件过大）");
      } else {
        setPreview({ path: relativePath, content });
      }
    } finally {
      setPreviewLoading(null);
    }
  };

  const tabs: Array<{ id: NodeDetailTab; label: string; count?: number }> = [
    { id: "conversation", label: "对话" },
    { id: "result", label: "结果" },
    { id: "artifacts", label: "产物文件", count: files.length },
    ...(notices.length > 0
      ? [{ id: "notices" as const, label: "提示", count: notices.length }]
      : []),
    { id: "execution", label: "执行信息" },
  ];

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

        {node.decision && (
          <p
            className={`mt-2 rounded-lg px-2.5 py-2 text-meta leading-relaxed ${
              node.decision === "approved"
                ? "bg-success/10 text-success"
                : "bg-error-bg text-error"
            }`}
          >
            审核{node.decision === "approved" ? "通过" : "驳回"}
            {node.decidedAt ? ` · ${formatDateTime(node.decidedAt)}` : ""}
            {node.decisionNote ? ` · ${node.decisionNote}` : ""}
          </p>
        )}

        {node.error && (
          <p className="mt-2 rounded-lg bg-error-bg px-2.5 py-2 text-meta leading-relaxed text-error">
            {node.error}
          </p>
        )}

        {canResume && node.nodeType === "employee" && (
          <div className="mt-3">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              icon={<RotateCw className="h-3.5 w-3.5" />}
              onClick={onResume}
            >
              从该节点重跑（重置下游）
            </Button>
          </div>
        )}
      </section>

      <SegmentedTabs options={tabs} value={tab} onChange={setTab} />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-body text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在读取节点详情
        </div>
      ) : tab === "conversation" ? (
        !hasConversation ? (
          <p className="py-10 text-center text-meta italic text-text-muted">
            （还没有记录到对话）
          </p>
        ) : (
          <div className="space-y-3">
            {attempts.map((attempt) => (
              <section
                key={attempt.attempt}
                className="overflow-hidden rounded-xl border border-border bg-surface-2/40"
              >
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-meta">
                  <span className="font-medium text-text-secondary">
                    第 {attempt.attempt} 次尝试
                  </span>
                  <span className="truncate font-mono text-caption text-text-muted">
                    {attempt.sessionId
                      ? `会话 ${attempt.sessionId.slice(0, 8)}`
                      : "无会话"}
                  </span>
                </div>
                <div className="space-y-3 p-3">
                  {attempt.messages.length === 0 ? (
                    <p className="text-meta italic text-text-muted">
                      （本次尝试没有对话记录）
                    </p>
                  ) : (
                    attempt.messages.map((message) => (
                      <MessageGroup
                        key={message.id}
                        events={message.content}
                        isUser={message.role === "user"}
                      />
                    ))
                  )}
                </div>
              </section>
            ))}

            {live && live.length > 0 && (
              <section className="overflow-hidden rounded-xl border border-accent/30 bg-accent-soft/20">
                <div className="border-b border-accent/20 px-3 py-2 text-meta font-medium text-accent">
                  实时执行
                </div>
                <div className="p-3">
                  <MessageGroup events={live} isUser={false} />
                </div>
              </section>
            )}
          </div>
        )
      ) : tab === "result" ? (
        detail?.result?.trim() ? (
          <div className="rounded-xl border border-border bg-surface-2/50 p-4">
            <MarkdownRenderer content={detail.result} />
          </div>
        ) : (
          <p className="py-10 text-center text-meta italic text-text-muted">
            （没有结果文件）
          </p>
        )
      ) : tab === "artifacts" ? (
        <div className="overflow-hidden rounded-xl border border-border bg-surface-2/50">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-meta font-medium text-text-secondary">
              产物文件（{files.length}）
            </span>
            <Button
              variant="ghost"
              size="xs"
              className="rounded-full"
              icon={<FolderOpen className="h-3.5 w-3.5" />}
              onClick={() => void openDir()}
            >
              打开目录
            </Button>
          </div>
          {files.length === 0 ? (
            <p className="px-3 py-8 text-center text-meta italic text-text-muted">
              （没有产物文件）
            </p>
          ) : (
            <div className="divide-y divide-border">
              {files.map((file) => (
                <div
                  key={file.relativePath}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <FileText className="h-4 w-4 shrink-0 text-text-muted" />
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-body text-text"
                      title={file.relativePath}
                    >
                      {file.relativePath}
                    </p>
                    <p className="font-mono text-caption text-text-muted">
                      {formatSize(file.size)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="shrink-0 rounded-full"
                    loading={previewLoading === file.relativePath}
                    onClick={() => void previewFile(file.relativePath)}
                  >
                    预览
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="shrink-0 rounded-full"
                    onClick={() => void openFile(file.relativePath)}
                  >
                    打开
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : tab === "notices" ? (
        <div className="space-y-2">
          {notices.map((notice, index) => (
            <div
              key={`${notice.type}-${index}`}
              className={`rounded-xl border px-3 py-2.5 text-meta leading-relaxed ${
                notice.level === "error"
                  ? "border-error/30 bg-error-bg text-error"
                  : notice.level === "warning"
                    ? "border-accent/30 bg-accent-soft/40 text-text-secondary"
                    : "border-border bg-surface-2/50 text-text-secondary"
              }`}
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-caption text-text-muted">
                <span>
                  {notice.type === "node_retry"
                    ? "重试"
                    : notice.type === "approval_decided"
                      ? "审核"
                      : "提示"}
                </span>
                <span className="font-mono">
                  {formatDateTime(notice.createdAt)}
                </span>
              </div>
              <p className="whitespace-pre-wrap">{notice.message}</p>
            </div>
          ))}
        </div>
      ) : (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-surface-2/50 p-4 font-sans text-meta leading-relaxed text-text-secondary">
          {detail?.execution || "（没有执行信息）"}
        </pre>
      )}

      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview ? `预览 · ${preview.path}` : "预览"}
        width="xl"
      >
        <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2/60 p-3 font-mono text-meta leading-relaxed text-text-secondary">
          {preview?.content}
        </pre>
      </Dialog>
    </div>
  );
}
