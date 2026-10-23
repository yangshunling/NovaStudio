/**
 * 编辑器内的调试状态栏
 *
 * 调试不跳转页面：运行状态、当前节点、进度、审核入口和产物都在画布下方。
 * 节点本身的颜色与徽标由 WorkflowCanvas 按 nodeStates 渲染。
 */

import { useEffect, useMemo, useState } from "react";
import { Check, FolderOpen, Square, X } from "lucide-react";
import type { WorkflowRunDetail } from "@shared/types";
import { formatDuration } from "../../lib/workflowFormat";
import { ACTIVE_RUN_STATUSES, RUN_STATUS } from "../../lib/workflowStatus";

export function WorkflowDebugPanel({
  detail,
  busy,
  onApprove,
  onCancel,
  onOpenArtifacts,
  onClose,
}: {
  detail: WorkflowRunDetail;
  busy: boolean;
  onApprove: (action: "approve" | "reject") => void;
  onCancel: () => void;
  onOpenArtifacts: () => void;
  onClose: () => void;
}) {
  const { run, nodes } = detail;
  const meta = RUN_STATUS[run.status];
  const Icon = meta.icon;
  const active = ACTIVE_RUN_STATUSES.has(run.status);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const awaiting = useMemo(
    () => nodes.find((node) => node.status === "awaiting_approval"),
    [nodes],
  );
  const awaitingConfig = useMemo(() => {
    if (!awaiting) return null;
    return run.graph.nodes.find((node) => node.id === awaiting.nodeId) ?? null;
  }, [run.graph.nodes, awaiting]);

  const done = nodes.filter(
    (node) => node.status === "succeeded" || node.status === "skipped",
  ).length;
  const current = nodes.find(
    (node) =>
      node.status === "running" ||
      node.status === "retrying" ||
      node.status === "awaiting_approval",
  );
  const percent = nodes.length === 0 ? 0 : Math.round((done / nodes.length) * 100);

  return (
    <section className="shrink-0 border-b border-border bg-surface-2/60">
      <div className="h-0.5 w-full bg-border">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <Icon
          className={`h-4 w-4 shrink-0 ${meta.className} ${
            run.status === "running" ? "animate-spin" : ""
          }`}
        />
        <span className={`shrink-0 text-body-lg font-semibold ${meta.className}`}>
          {meta.label}
        </span>

        <span className="shrink-0 text-meta text-text-muted">
          {done}/{nodes.length} 节点
        </span>

        {current && (
          <span className="min-w-0 truncate text-meta text-text-secondary">
            当前：{current.nodeName}
          </span>
        )}

        <span className="shrink-0 font-mono text-meta text-text-muted">
          {formatDuration(run.startedAt, run.finishedAt, now)}
        </span>

        {run.error && (
          <span
            className="max-w-64 truncate text-meta text-error"
            title={run.error}
          >
            {run.error}
          </span>
        )}

        <div className="min-w-4 flex-1" />

        {awaiting && (
          <>
            <button
              type="button"
              onClick={() => onApprove("reject")}
              disabled={busy}
              className="ui-btn-ghost flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-meta font-medium active:scale-95 disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              驳回
            </button>
            <button
              type="button"
              onClick={() => onApprove("approve")}
              disabled={busy}
              className="ui-btn-primary flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-meta font-medium active:scale-95 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
              通过
            </button>
          </>
        )}

        <button
          type="button"
          onClick={onOpenArtifacts}
          className="ui-btn-ghost flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-meta font-medium active:scale-95"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          产物
        </button>

        {active ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-error/40 bg-error-bg px-3 text-meta font-medium text-error transition-colors hover:border-error active:scale-95 disabled:opacity-50"
          >
            <Square className="h-3 w-3" />
            终止
          </button>
        ) : (
          <button
            type="button"
            onClick={onClose}
            className="ui-btn-ghost h-8 shrink-0 rounded-full px-3 text-meta font-medium active:scale-95"
          >
            关闭调试
          </button>
        )}
      </div>

      {awaiting && awaitingConfig && (
        <div className="border-t border-border px-4 py-2.5">
          <p className="text-meta font-medium text-text-secondary">
            等待审核 · {awaiting.nodeName}
            {awaiting.employeeName ? ` · ${awaiting.employeeName}` : ""}
          </p>
          <pre className="mt-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface/70 p-2.5 font-sans text-meta leading-relaxed text-text">
            {awaitingConfig.config.taskDetail || "（未填写任务详情）"}
          </pre>
        </div>
      )}
    </section>
  );
}
