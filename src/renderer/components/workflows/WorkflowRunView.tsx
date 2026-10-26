/**
 * 工作流运行详情
 *
 * 左侧：本次运行的全部节点，点击切换。
 * 右侧：选中节点的执行信息 —— 结果优先展示，输入与上下文、诊断信息默认折叠。
 * 页面底部保留事件日志，便于排查调度顺序。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  FileText,
  FolderOpen,
  Loader2,
  PauseCircle,
  Square,
  X,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toast";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { formatDateTime, formatDuration, formatSize } from "../../lib/workflowFormat";
import {
  ACTIVE_RUN_STATUSES,
  EVENT_LABEL,
  NODE_STATUS,
  RUN_STATUS,
} from "../../lib/workflowStatus";
import type {
  WorkflowNodeRun,
  WorkflowNodeRunDetail,
  WorkflowNodeRunStatus,
  WorkflowRunDetail,
  WorkflowRunStatus,
} from "@shared/types";

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

  /** 隔离告警以事件形式落库，按当前节点筛选 */
  const selectedWarnings = useMemo(() => {
    if (!detail || !selectedNode) return [];
    return detail.events
      .filter(
        (event) =>
          event.nodeRunId === selectedNode.id &&
          event.type === "log" &&
          event.payload.level === "warning" &&
          event.payload.attempt === selectedNode.attempt,
      )
      .map((event) =>
        typeof event.payload.message === "string" ? event.payload.message : "",
      )
      .filter(Boolean);
  }, [detail, selectedNode]);

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
        if (alive) setNodeDetail(next);
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

  const copyText = async (label: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制${label}`);
    } catch {
      toast.error("复制失败");
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

  const { run, events } = detail;
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
                  warnings={selectedWarnings}
                  onCopy={copyText}
                  onOpenFolder={async () => {
                    const ok = await ipc.openWorkflowNodeArtifacts(
                      runId,
                      selectedNode.id,
                    );
                    if (!ok) toast.error("无法打开节点产物目录");
                  }}
                  onOpenFile={async (relativePath) => {
                    const ok = await ipc.openWorkflowNodeFile(
                      runId,
                      selectedNode.id,
                      relativePath,
                    );
                    if (!ok) toast.error("无法打开文件");
                  }}
                />
              ) : (
                <div className="flex flex-col items-center gap-2 py-16 text-center text-text-muted">
                  <FileText className="h-5 w-5 opacity-50" />
                  <p className="text-body">左侧选择一个节点查看执行详情</p>
                </div>
              )}

              <details className="mt-4 rounded-xl border border-border bg-surface-2/40 open:pb-2">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-body font-medium text-text-secondary">
                  <ChevronDown className="details-chevron h-4 w-4 transition-transform" />
                  事件日志
                  <span className="font-mono text-caption text-text-muted">
                    {events.length}
                  </span>
                </summary>
                <div className="max-h-64 space-y-1 overflow-y-auto px-3 pb-2">
                  {[...events].reverse().map((event) => {
                    const node = event.nodeRunId
                      ? nodes.find((item) => item.id === event.nodeRunId)
                      : null;
                    const label = EVENT_LABEL[event.type] ?? event.type;
                    const status =
                      typeof event.payload.status === "string"
                        ? event.payload.status
                        : null;
                    const message =
                      typeof event.payload.error === "string"
                        ? event.payload.error
                        : typeof event.payload.message === "string"
                          ? event.payload.message
                          : "";
                    return (
                      <div
                        key={event.seq}
                        className="flex items-start gap-3 rounded-lg px-1.5 py-1 text-meta hover:bg-surface-hover/60"
                      >
                        <span className="shrink-0 font-mono text-caption text-text-muted">
                          {new Date(event.createdAt).toLocaleTimeString("zh-CN", {
                            hour12: false,
                          })}
                        </span>
                        <span className="shrink-0 font-medium text-text-secondary">
                          {label}
                        </span>
                        {node && (
                          <span className="min-w-0 truncate text-text">
                            {node.nodeName}
                          </span>
                        )}
                        {status && (
                          <span className="shrink-0 text-text-muted">
                            {NODE_STATUS[status as WorkflowNodeRunStatus]?.label ??
                              status}
                          </span>
                        )}
                        {message && (
                          <span
                            className={`min-w-0 truncate ${
                              event.payload.level === "warning"
                                ? "text-agent-amber"
                                : "text-error"
                            }`}
                            title={message}
                          >
                            {message}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </details>
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
  warnings,
  onCopy,
  onOpenFolder,
  onOpenFile,
}: {
  node: WorkflowNodeRun;
  detail: WorkflowNodeRunDetail | null;
  loading: boolean;
  now: number;
  warnings: string[];
  onCopy: (label: string, text: string) => void;
  onOpenFolder: () => void;
  onOpenFile: (relativePath: string) => void;
}) {
  const meta = NODE_STATUS[node.status];
  const request = detail?.request ?? "";
  const result = detail?.result ?? "";
  const files = detail?.files ?? [];
  const hasDiagnostics = warnings.length > 0 || files.length > 0;

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
      ) : (
        <>
          {/* 结果：节点最主要的输出，放在最前面 */}
          <section className="rounded-xl border border-border bg-surface-2/50">
            <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <span className="min-w-0 flex-1 text-body font-medium text-text">
                结果
              </span>
              {result && (
                <button
                  type="button"
                  onClick={() => onCopy("结果", result)}
                  title="复制结果"
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-caption text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
                >
                  <Copy className="h-3 w-3" />
                  复制
                </button>
              )}
            </header>
            {result ? (
              <div className="max-h-[28rem] overflow-y-auto p-3">
                <MarkdownRenderer content={result} />
              </div>
            ) : (
              <p className="px-3 py-3 text-meta italic text-text-muted">
                （还没有返回内容）
              </p>
            )}
          </section>

          {/* 输入与上下文：默认折叠 */}
          <details className="rounded-xl border border-border bg-surface-2/50">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-body font-medium text-text-secondary">
              <ChevronDown className="details-chevron h-4 w-4 transition-transform" />
              输入与上下文
            </summary>
            <div className="border-t border-border p-3">
              {request ? (
                <>
                  <div className="mb-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => onCopy("输入", request)}
                      title="复制输入"
                      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-caption text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
                    >
                      <Copy className="h-3 w-3" />
                      复制
                    </button>
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    <MarkdownRenderer content={request} />
                  </div>
                </>
              ) : (
                <p className="text-meta italic text-text-muted">
                  （没有记录到输入）
                </p>
              )}
            </div>
          </details>

          {/* 诊断：告警 / 记录文件，默认折叠 */}
          {hasDiagnostics && (
            <details className="rounded-xl border border-border bg-surface-2/50">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-body font-medium text-text-secondary">
                <ChevronDown className="details-chevron h-4 w-4 transition-transform" />
                诊断
              </summary>
              <div className="space-y-3 border-t border-border p-3">
                {warnings.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-meta font-medium text-text-secondary">
                      告警
                    </p>
                    <ul className="space-y-1">
                      {warnings.map((warning, index) => (
                        <li
                          key={`${index}-${warning}`}
                          className="text-meta leading-relaxed text-agent-amber"
                        >
                          {warning}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <p className="text-meta font-medium text-text-secondary">
                      记录文件
                    </p>
                    <button
                      type="button"
                      onClick={onOpenFolder}
                      className="ui-btn-ghost rounded-md px-2 py-1 text-caption font-medium"
                    >
                      打开目录
                    </button>
                  </div>
                  {files.length === 0 ? (
                    <p className="text-meta italic text-text-muted">
                      （该节点还没有记录文件）
                    </p>
                  ) : (
                    <div className="divide-y divide-border">
                      {files.map((file) => (
                        <button
                          key={file.relativePath}
                          type="button"
                          onClick={() => onOpenFile(file.relativePath)}
                          title={`打开 ${file.relativePath}`}
                          className="flex w-full items-center gap-2.5 px-1 py-2 text-left text-meta transition-colors hover:bg-surface-hover"
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                          <span className="min-w-0 flex-1 truncate font-mono text-text-secondary">
                            {file.relativePath}
                          </span>
                          <span className="shrink-0 font-mono text-caption text-text-muted">
                            {formatSize(file.size)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
