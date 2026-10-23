/**
 * 运行记录列表页
 *
 * 工作区级 / 工作流级共用。表格列出每次执行的状态、开始、完成、总耗时，
 * 点击「详情」进入该次运行的节点明细页。
 */

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Circle,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { formatDateTime, formatDuration } from "../../lib/workflowFormat";
import { ACTIVE_RUN_STATUSES, RUN_STATUS } from "../../lib/workflowStatus";
import type { WorkflowRun } from "@shared/types";

export function WorkflowRunHistoryView({
  title,
  workspaceId,
  workflowId,
  onBack,
  onOpenRun,
}: {
  title: string;
  /** 工作区级入口 */
  workspaceId?: string;
  /** 工作流级入口 */
  workflowId?: string;
  onBack: () => void;
  onOpenRun: (runId: string, workflowId: string) => void;
}) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = workspaceId
        ? await ipc.listWorkspaceRuns(workspaceId)
        : workflowId
          ? await ipc.listWorkflowRuns(workflowId)
          : [];
      setRuns(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, workflowId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // 只有存在活跃运行时才轮询；历史记录不会变化，没必要一直打 IPC
  const hasActive = runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  const showWorkflowColumn = !!workspaceId;
  const gridClass = showWorkflowColumn
    ? "grid grid-cols-[96px_minmax(180px,1fr)_120px_170px_170px_90px_80px] items-center gap-3"
    : "grid grid-cols-[96px_120px_170px_170px_90px_80px] items-center gap-3";

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <div className="ui-page relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center gap-3 border-b border-border px-4">
          <button
            type="button"
            onClick={onBack}
            title="返回"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-body text-text-muted transition-colors hover:bg-surface-hover hover:text-text active:scale-95"
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </button>

          <span className="h-5 w-px shrink-0 bg-border" />

          <p className="min-w-0 truncate text-heading font-semibold text-text">
            {title}
          </p>

          <span className="shrink-0 rounded-full bg-surface-hover px-2.5 py-1 font-mono text-meta text-text-muted">
            共 {runs.length} 次执行
          </span>

          <div className="min-w-0 flex-1" />

          <button
            type="button"
            onClick={() => void load()}
            className="ui-btn-ghost flex h-8 shrink-0 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95"
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <p className="py-10 text-center text-body text-error">{error}</p>
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-body text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在读取运行记录
            </div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center text-text-muted">
              <Circle className="h-5 w-5 opacity-50" />
              <p className="text-body">还没有运行记录</p>
              <p className="text-meta">在工作流里点「调试」后会生成记录。</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              <div
                className={`${gridClass} border-b border-border bg-surface-hover/50 px-4 py-2.5 text-meta font-medium text-text-muted`}
              >
                <span>运行</span>
                {showWorkflowColumn && <span>工作流</span>}
                <span>状态</span>
                <span>开始时间</span>
                <span>完成时间</span>
                <span>总耗时</span>
                <span />
              </div>

              {runs.map((run) => {
                const meta = RUN_STATUS[run.status];
                const Icon = meta.icon;
                const active = ACTIVE_RUN_STATUSES.has(run.status);

                return (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => onOpenRun(run.id, run.workflowId)}
                    className={`${gridClass} w-full border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-surface-hover`}
                  >
                    <span className="font-mono text-meta text-text-secondary">
                      #{run.id.slice(0, 8)}
                    </span>

                    {showWorkflowColumn && (
                      <span className="min-w-0 truncate text-body text-text">
                        {run.workflowName}
                      </span>
                    )}

                    <span
                      className={`flex items-center gap-1.5 text-meta font-medium ${meta.className}`}
                    >
                      <Icon
                        className={`h-3.5 w-3.5 shrink-0 ${active ? "animate-spin" : ""}`}
                      />
                      {meta.label}
                    </span>

                    <span className="font-mono text-meta text-text-secondary">
                      {formatDateTime(run.startedAt ?? run.createdAt)}
                    </span>
                    <span className="font-mono text-meta text-text-secondary">
                      {formatDateTime(run.finishedAt)}
                    </span>
                    <span className="font-mono text-meta text-text-secondary">
                      {formatDuration(run.startedAt, run.finishedAt, Date.now())}
                    </span>

                    <span className="flex items-center justify-end gap-1 text-meta font-medium text-accent">
                      详情
                      <ChevronRight className="h-3.5 w-3.5" />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
