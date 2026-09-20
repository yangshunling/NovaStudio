/**
 * 任务卡片 — 自动化看板中的单个任务条目
 *
 * 状态色编码（pending=muted, running=accent pulse, completed=success, failed=error）
 * hover 显示操作按钮（重试 / 删除）；执行中显示旋转图标与「停止」按钮
 */

import { RotateCcw, AlertCircle, Loader2, Square, Folder, Clock } from "lucide-react";
import { ConfirmDeleteButton } from "../ui/ConfirmDeleteButton";
import { AgentPill } from "../ui/AgentPill";
import { Pill } from "../ui/Pill";
import { StatusDot } from "../ui/StatusDot";
import { timeAgo } from "../../lib/utils";
import type { AutomationTask, Project } from "@shared/types";
import type { AgentInfo } from "@shared/contracts/agent";

export function TaskCard({
  task,
  project,
  agents,
  onDelete,
  onRetry,
  onStop,
  onViewDetail,
}: {
  task: AutomationTask;
  project?: Project;
  agents: AgentInfo[];
  onDelete: () => void;
  onRetry: () => void;
  onStop: () => void;
  onViewDetail: () => void;
}) {
  const isRunning = task.status === "running";
  const isFailed = task.status === "failed";
  const isCompleted = task.status === "completed";
  const canDelete = task.status === "pending" || task.status === "completed" || task.status === "failed";
  // 执行中（有 sessionId）/ 已完成 / 失败 都可以查看详情
  const canViewDetail = (isRunning && !!task.sessionId) || isCompleted || isFailed;

  const borderColor =
    isRunning ? "border-l-accent"
    : isCompleted ? "border-l-success"
    : isFailed ? "border-l-error"
    : "border-l-border";

  return (
    <div
      className={`group relative rounded-lg border border-border border-l-[3px] ${borderColor} bg-surface-2/60 p-card shadow-[var(--c-shadow-sm)] backdrop-blur-sm transition-colors hover:bg-surface-2/80 ${
        canViewDetail ? "cursor-pointer" : ""
      }`}
      onClick={() => canViewDetail && onViewDetail()}
    >
      {/* 状态点 + Prompt — 右侧留出操作按钮空间 */}
      <div className="flex items-start gap-2 pr-14">
        <StatusDot
          status={isRunning ? "streaming" : isCompleted ? "success" : isFailed ? "error" : "inactive"}
          className="mt-1.5"
        />
        <p className="min-w-0 flex-1 truncate text-body-lg text-text" title={task.prompt}>
          {task.prompt}
        </p>
      </div>

      {/* 错误信息（失败时） */}
      {isFailed && task.error && (
        <div className="mt-2 flex items-center gap-1 rounded bg-error-bg/50 px-2 py-1 text-meta text-error">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{task.error}</span>
        </div>
      )}

      {/* 项目 + Agent 标签 */}
      <div className="mt-2.5 flex items-center gap-2 text-caption">
        {project && (
          <Pill icon={<Folder className="h-3 w-3" />} variant="neutral">
            {project.name}
          </Pill>
        )}
        {task.agentId && <AgentPill agents={agents} agentId={task.agentId} />}
      </div>

      {/* 时间 */}
      <div className="mt-2 flex items-center gap-1 text-caption text-text-muted">
        <Clock className="h-3 w-3" />
        {isRunning && task.startedAt
          ? `执行中 · ${timeAgo(task.startedAt)}`
          : isCompleted && task.completedAt
            ? `完成 · ${timeAgo(task.completedAt)}`
            : isFailed && task.completedAt
              ? `失败 · ${timeAgo(task.completedAt)}`
              : timeAgo(task.createdAt)}
      </div>

      {/* 操作按钮（hover 显示；失败态常显，因为"手动重试"是它的主要出路） */}
      {canDelete && (
        <div
          className={`absolute right-2 top-2 flex items-center gap-1 transition-opacity ${
            isFailed ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          {isFailed && (
            <button
              onClick={(e) => { e.stopPropagation(); onRetry(); }}
              title="重试"
              className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover hover:text-accent"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
          <ConfirmDeleteButton onConfirm={onDelete} className="rounded-md" iconSize={16} />
        </div>
      )}

      {/* 执行中：旋转图标 + 停止按钮 */}
      {isRunning && (
        <div className="absolute right-2 top-2 flex items-center gap-1">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          <button
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            title="停止执行"
            className="rounded-md p-1 text-text-muted hover:bg-surface-hover hover:text-error"
          >
            <Square className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
