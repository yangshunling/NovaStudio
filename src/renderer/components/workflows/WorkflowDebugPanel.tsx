/**
 * 编辑器内的调试状态栏
 *
 * 调试不跳转页面：运行状态、当前节点、进度、审核入口和产物都在画布下方。
 * 节点本身的颜色与徽标由 WorkflowCanvas 按 nodeStates 渲染。
 */

import { useEffect, useMemo, useState } from "react";
import { Check, FileText, FolderOpen, Square, X } from "lucide-react";
import type { WorkflowRunDetail } from "@shared/types";
import { formatDuration } from "../../lib/workflowFormat";
import { ACTIVE_RUN_STATUSES, RUN_STATUS } from "../../lib/workflowStatus";
import { Button } from "../ui/Button";

export function WorkflowDebugPanel({
  detail,
  busy,
  onApprove,
  onCancel,
  onOpenArtifacts,
  onOpenRun,
  onClose,
}: {
  detail: WorkflowRunDetail;
  busy: boolean;
  onApprove: (
    nodeRunId: string,
    action: "approve" | "reject",
    note: string,
  ) => void;
  onCancel: () => void;
  onOpenArtifacts: () => void;
  onOpenRun: () => void;
  onClose: () => void;
}) {
  const { run, nodes } = detail;
  const meta = RUN_STATUS[run.status];
  const Icon = meta.icon;
  const active = ACTIVE_RUN_STATUSES.has(run.status);

  const [now, setNow] = useState(Date.now());
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const awaitingNodes = useMemo(
    () => nodes.filter((node) => node.status === "awaiting_approval"),
    [nodes],
  );
  /*
   * DAG 并行时可能有多个节点同时等待审核。
   * 调试栏一次只展示一个，但必须能切换，否则第二个节点在调试态下没有审批入口。
   */
  const [awaitingId, setAwaitingId] = useState<string | null>(null);
  const awaiting =
    awaitingNodes.find((node) => node.id === awaitingId) ?? awaitingNodes[0];

  // 切换到新的待审核节点时清空上一轮备注
  useEffect(() => {
    setNote("");
  }, [awaiting?.id]);

  const done = nodes.filter(
    (node) => node.status === "succeeded" || node.status === "skipped",
  ).length;
  const currentNodes = nodes.filter(
    (node) =>
      node.status === "running" ||
      node.status === "retrying" ||
      node.status === "awaiting_approval",
  );
  const current = currentNodes[0];
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
            {currentNodes.length > 1
              ? ` 等 ${currentNodes.length} 个节点`
              : ""}
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
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 rounded-full"
              icon={<X className="h-3.5 w-3.5" />}
              onClick={() => onApprove(awaiting.id, "reject", note.trim())}
              disabled={busy}
            >
              驳回
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="shrink-0 rounded-full"
              icon={<Check className="h-3.5 w-3.5" />}
              onClick={() => onApprove(awaiting.id, "approve", note.trim())}
              disabled={busy}
            >
              通过
            </Button>
          </>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 rounded-full"
          icon={<FileText className="h-3.5 w-3.5" />}
          onClick={onOpenRun}
          title="打开本次运行的完整详情（结果 / 产物 / 对话）"
        >
          运行详情
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 rounded-full"
          icon={<FolderOpen className="h-3.5 w-3.5" />}
          onClick={onOpenArtifacts}
        >
          产物
        </Button>

        {active ? (
          <Button
            variant="dangerSoft"
            size="sm"
            className="shrink-0 rounded-full"
            icon={<Square className="h-3 w-3" />}
            onClick={onCancel}
            disabled={busy}
          >
            终止
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 rounded-full"
            onClick={onClose}
          >
            关闭调试
          </Button>
        )}
      </div>

      {awaiting && (
        <div className="border-t border-border px-4 py-2.5">
          {awaitingNodes.length > 1 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="text-caption text-text-muted">待审核节点：</span>
              {awaitingNodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => setAwaitingId(node.id)}
                  className={`rounded-full px-2.5 py-1 text-caption transition-colors ${
                    node.id === awaiting.id
                      ? "bg-accent-soft font-medium text-accent"
                      : "bg-surface/70 text-text-secondary hover:text-text"
                  }`}
                >
                  {node.nodeName}
                </button>
              ))}
            </div>
          )}
          <p className="text-meta font-medium text-text-secondary">
            产物待审核 · {awaiting.nodeName}
            {awaiting.employeeName ? ` · ${awaiting.employeeName}` : ""}
          </p>
          <pre className="mt-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface/70 p-2.5 font-sans text-meta leading-relaxed text-text">
            {awaiting.outputSummary || "（节点已完成，产物见运行详情）"}
          </pre>
          <p className="mt-1.5 text-caption text-text-muted">
            通过后节点完成并继续下游；驳回会立即终止本次运行，不能重试。
          </p>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            placeholder="审核备注（驳回时建议填写原因，会写入节点历史）"
            className="ui-ring mt-2 w-full resize-none rounded-lg bg-surface/70 px-2.5 py-2 text-meta text-text placeholder-text-muted outline-none"
          />
        </div>
      )}
    </section>
  );
}
