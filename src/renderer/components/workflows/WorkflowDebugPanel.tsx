/**
 * 编辑器内的调试状态栏
 *
 * 调试不跳转页面：运行状态、当前节点、进度、审核入口和产物都在画布下方。
 * 节点本身的颜色与徽标由 WorkflowCanvas 按 nodeStates 渲染。
 */

import { useEffect, useMemo, useState } from "react";
import { Check, FileText, FolderOpen, Pencil, Square, X } from "lucide-react";
import type { WorkflowRunDetail } from "@shared/types";
import { ACTIVE_RUN_STATUSES, RUN_STATUS } from "../../lib/workflow/status";
import { Button } from "../ui/Button";
import { Elapsed } from "../ui/Elapsed";

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
    action: "approve" | "reject" | "revise",
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

  const [note, setNote] = useState("");

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

  // 「要求修改」的剩余轮数：由运行图快照里的节点配置与当前 round 推导
  const awaitingNodeConfig = awaiting
    ? run.graph.nodes.find((item) => item.id === awaiting.nodeId)
    : null;
  const maxRevisions = Math.min(
    3,
    Math.max(0, Math.round(Number(awaitingNodeConfig?.config.maxRevisions ?? 1))),
  );
  const remainingRevisions = awaiting
    ? Math.max(0, maxRevisions - ((awaiting.round ?? 1) - 1))
    : 0;

  // 切换到新的待审核节点 / 新的一轮时清空上一轮备注
  useEffect(() => {
    setNote("");
  }, [awaiting?.id, awaiting?.round]);

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
    <section className="shrink-0 border-b border-border bg-surface-2/40">
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
        <span className={`shrink-0 ui-type-item font-semibold ${meta.className}`}>
          {meta.label}
        </span>

        <span className="shrink-0 ui-type-note text-text-muted">
          {done}/{nodes.length} 节点
        </span>

        {current && (
          <span className="min-w-0 truncate ui-type-note text-text-secondary">
            当前：{current.nodeName}
            {currentNodes.length > 1
              ? ` 等 ${currentNodes.length} 个节点`
              : ""}
          </span>
        )}

        <Elapsed
          startedAt={run.startedAt}
          finishedAt={run.finishedAt}
          className="shrink-0 ui-type-code text-text-muted"
        />

        {run.error && (
          <span
            className="max-w-64 truncate ui-type-note text-error"
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
            {remainingRevisions > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 rounded-full"
                icon={<Pencil className="h-3.5 w-3.5" />}
                onClick={() => onApprove(awaiting.id, "revise", note.trim())}
                disabled={busy || !note.trim()}
                title={
                  note.trim()
                    ? `在同一个会话里继续修改（本轮最多还可修改 ${remainingRevisions} 次）`
                    : "请先填写修改意见"
                }
              >
                要求修改
              </Button>
            )}
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
              <span className="ui-type-sub text-text-muted">待审核节点：</span>
              {awaitingNodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => setAwaitingId(node.id)}
                  className={`rounded-full px-2.5 py-1 ui-type-sub transition-colors ${
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
          <p className="ui-type-label text-text-secondary">
            产物待审核 · {awaiting.nodeName}
            {awaiting.employeeName ? ` · ${awaiting.employeeName}` : ""}
          </p>
          <pre className="mt-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface/70 p-2.5 font-sans ui-type-note leading-relaxed text-text">
            {awaiting.outputSummary || "（节点已完成，产物见运行详情）"}
          </pre>
          <p className="mt-1.5 ui-type-sub text-text-muted">
            通过后节点完成并继续下游；「要求修改」会在同一个会话里带着意见重做
            （最多 {maxRevisions} 轮）；驳回会立即终止本次运行，不能重试。
          </p>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            placeholder="审核备注（要求修改时必填，会作为下一轮的评审意见）"
            className="ui-ring mt-2 w-full resize-none rounded-lg bg-surface/70 px-2.5 py-2 ui-type-note text-text placeholder-text-muted outline-none"
          />
        </div>
      )}
    </section>
  );
}
