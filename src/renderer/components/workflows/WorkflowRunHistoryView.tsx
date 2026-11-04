/**
 * 运行记录列表页
 *
 * 工作区级 / 工作流级共用。表格列出每次执行的状态、开始、完成、总耗时，
 * 点击「详情」进入该次运行的节点明细页。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Circle,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import { Button } from "../ui/Button";
import { EmptyState, ErrorState, LoadingState } from "../ui/EmptyState";
import { Page } from "../ui/Page";
import { SegmentedTabs } from "../ui/SegmentedTabs";
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
  const [sourceFilter, setSourceFilter] = useState<
    "all" | "manual" | "trigger"
  >("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "failed" | "succeeded"
  >("all");
  const [busyRunId, setBusyRunId] = useState<string | null>(null);

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
  const visibleRuns = useMemo(() => {
    // 续跑的运行 createdAt 可能很早，但仍在执行：活跃运行始终置顶
    const ordered = [...runs].sort((a, b) => {
      const activeA = ACTIVE_RUN_STATUSES.has(a.status);
      const activeB = ACTIVE_RUN_STATUSES.has(b.status);
      if (activeA !== activeB) return activeA ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
    return ordered.filter((run) => {
      if (sourceFilter !== "all" && run.source !== sourceFilter) return false;
      if (statusFilter === "active")
        return ACTIVE_RUN_STATUSES.has(run.status);
      if (statusFilter === "failed")
        return run.status === "failed" || run.status === "interrupted";
      if (statusFilter === "succeeded") return run.status === "succeeded";
      return true;
    });
  }, [runs, sourceFilter, statusFilter]);

  /** 以相同工作流重新发起一次手动运行 */
  const rerun = async (run: WorkflowRun) => {
    if (busyRunId) return;
    setBusyRunId(run.id);
    try {
      const next = await ipc.startWorkflowRun(run.workflowId);
      onOpenRun(next.id, next.workflowId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 5000);
    } finally {
      setBusyRunId(null);
    }
  };

  /** 删除单次运行及其会话 / 产物 */
  const removeRun = async (run: WorkflowRun) => {
    if (busyRunId) return;
    const confirmed = await confirmDialog({
      title: `删除运行 #${run.id.slice(0, 8)}？`,
      message:
        "会同时删除本次运行的节点会话、事件记录与产物目录，无法恢复。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) return;

    setBusyRunId(run.id);
    try {
      await ipc.deleteWorkflowRun(run.id);
      await load();
      toast.success("运行记录已删除");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 5000);
    } finally {
      setBusyRunId(null);
    }
  };

  const hasActive = runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [hasActive, load]);


  return (
    <Page>
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center gap-3 border-b border-border px-4">
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft className="h-4 w-4" />}
            onClick={onBack}
            title="返回"
          >
            返回
          </Button>

          <span className="h-5 w-px shrink-0 bg-border" />

          <p className="ui-serif min-w-0 truncate text-title font-semibold tracking-wide text-text-secondary">
            {title}
          </p>

          <span className="shrink-0 rounded-full bg-surface-hover px-2.5 py-1 font-mono text-meta text-text-muted">
            共 {runs.length} 次执行
          </span>

          <div className="min-w-0 flex-1" />

          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 rounded-full"
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => void load()}
          >
            刷新
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <ErrorState message={error} size="compact" />
          ) : loading ? (
            <LoadingState text="正在读取运行记录" size="compact" />
          ) : runs.length === 0 ? (
            <EmptyState
              size="compact"
              icon={<Circle />}
              title="还没有运行记录"
              description="在工作流里运行，或由触发器启动后，会在这里生成记录。"
            />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <SegmentedTabs
                  value={sourceFilter}
                  onChange={setSourceFilter}
                  options={[
                    { id: "all", label: "全部来源" },
                    { id: "manual", label: "手动" },
                    { id: "trigger", label: "触发器" },
                  ] as const}
                />
                <SegmentedTabs
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { id: "all", label: "全部状态" },
                    { id: "active", label: "进行中" },
                    { id: "failed", label: "失败" },
                    { id: "succeeded", label: "成功" },
                  ] as const}
                />
                <span className="ml-auto font-mono text-caption text-text-muted">
                  {visibleRuns.length} / {runs.length}
                </span>
              </div>

              {visibleRuns.length === 0 ? (
                <p className="py-12 text-center text-body text-text-muted">
                  没有匹配的运行记录
                </p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border">
                  <div className="flex items-center gap-3 border-b border-border bg-surface-hover/50 px-4 py-2.5 text-meta font-medium text-text-muted">
                    <span className="w-24 shrink-0">状态</span>
                    <span className="min-w-0 flex-1">工作流 / 来源 / 标识</span>
                    <span className="w-44 shrink-0 text-right">操作</span>
                  </div>

                  {visibleRuns.map((run) => {
                const meta = RUN_STATUS[run.status];
                const Icon = meta.icon;
                const active = ACTIVE_RUN_STATUSES.has(run.status);
                const startedAt = run.startedAt ?? run.createdAt;

                return (
                  <div
                    key={run.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenRun(run.id, run.workflowId)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenRun(run.id, run.workflowId);
                      }
                    }}
                    className="flex w-full cursor-pointer items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-surface-hover"
                  >
                    <span
                      className={`flex w-24 shrink-0 items-center gap-1.5 pt-0.5 text-meta font-medium ${meta.className}`}
                    >
                      <Icon
                        className={`h-3.5 w-3.5 shrink-0 ${active ? "animate-spin" : ""}`}
                      />
                      {meta.label}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span className="min-w-0 truncate text-body font-medium text-text">
                          {run.workflowName}
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${
                            run.source === "trigger"
                              ? "bg-accent-soft text-accent"
                              : "bg-surface-hover text-text-muted"
                          }`}
                        >
                          {run.source === "trigger" ? "触发器" : "手动"}
                        </span>
                        {run.source === "trigger" && run.triggerId && (
                          <span
                            className="font-mono text-caption text-text-muted"
                            title={run.triggerId}
                          >
                            {run.triggerId.slice(0, 8)}
                          </span>
                        )}
                        <span className="font-mono text-caption text-text-muted">
                          {formatDateTime(startedAt)}
                        </span>
                        <span className="text-caption text-text-muted">→</span>
                        <span className="font-mono text-caption text-text-muted">
                          {formatDateTime(run.finishedAt)}
                        </span>
                        <span className="font-mono text-caption text-text-secondary">
                          {formatDuration(run.startedAt, run.finishedAt, Date.now())}
                        </span>
                      </div>

                      {/* 两个唯一标识始终完整展示，便于和产物目录 / 数据库对账 */}
                      <div className="mt-1 flex flex-col gap-0.5 font-mono text-caption text-text-muted">
                        <span className="break-all" title="工作流 ID">
                          工作流 ID：{run.workflowId}
                        </span>
                        <span className="break-all" title="运行 ID">
                          运行 ID：{run.id}
                        </span>
                      </div>
                      {run.error && (
                        <p
                          className="mt-1 truncate text-caption text-error"
                          title={run.error}
                        >
                          {run.error}
                        </p>
                      )}
                    </div>

                    <span className="flex w-44 shrink-0 items-center justify-end gap-1 pt-0.5">
                      <Button
                        variant="ghost"
                        size="xs"
                        className="rounded-full"
                        onClick={(event) => {
                          event.stopPropagation();
                          void rerun(run);
                        }}
                        disabled={active || busyRunId !== null}
                      >
                        重跑
                      </Button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void removeRun(run);
                        }}
                        disabled={active || busyRunId !== null}
                        className="flex h-7 items-center rounded-full px-2.5 text-meta font-medium text-error transition-colors hover:bg-error-bg active:scale-95 disabled:opacity-40"
                      >
                        删除
                      </button>
                      <span className="flex items-center gap-1 text-meta font-medium text-accent">
                        详情
                        <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    </span>
                  </div>
                );
                  })}
                </div>
              )}
            </>
          )}
        </div>
    </Page>
  );
}
