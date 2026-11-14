/**
 * 任务卡片 — 自动化看板中的单个任务条目
 *
 * 状态色编码（pending=muted, running=accent pulse, completed=success, failed=error）
 * hover 显示操作按钮（重试 / 删除）；执行中显示旋转图标与「停止」按钮
 */

import { RotateCcw, AlertCircle, Square, Clock, UserRound } from "lucide-react";
import { ConfirmDeleteButton } from "../ui/ConfirmDeleteButton";
import { IconButton } from "../ui/IconButton";
import { AgentPill } from "../ui/AgentPill";
import { FolderTypeIcon } from "../ui/FolderTypeIcon";
import { Pill } from "../ui/Pill";
import { StatusDot } from "../ui/StatusDot";
import { timeAgo } from "../../lib/utils";
import { useEmployeesStore } from "../../stores/employees";
import type { AutomationTask, Project } from "@shared/types";
import type { AgentInfo } from "@shared/contracts/agent";
import { Spinner } from "../ui/Spinner";

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
  const employees = useEmployeesStore((s) => s.employees);
  const employee = task.employeeId
    ? employees.find((item) => item.id === task.employeeId)
    : null;

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
      className={`group relative rounded-xl border border-border border-l-[3px] ${borderColor} bg-surface-2/40 p-card shadow-[var(--c-shadow-sm)] transition-all hover:-translate-y-0.5 hover:bg-surface-2/80 ${
        canViewDetail ? "cursor-pointer" : ""
      }`}
      onClick={() => canViewDetail && onViewDetail()}
    >
      {/* 状态点 + Prompt — 右侧留出操作按钮空间 */}
      <div className="flex items-start gap-2 pr-24">
        <StatusDot
          status={isRunning ? "streaming" : isCompleted ? "success" : isFailed ? "error" : "inactive"}
          className="mt-1.5"
        />
        <p
          className="line-clamp-2 min-w-0 flex-1 ui-type-item leading-snug text-text"
          title={task.prompt}
        >
          {task.prompt}
        </p>
      </div>

      {/* 错误信息（失败时） */}
      {isFailed && task.error && (
        <div className="mt-2 flex items-center gap-1 rounded-sm bg-error-bg/50 px-2 py-1 ui-type-note text-error">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{task.error}</span>
        </div>
      )}

      {/* 项目 + Agent 标签 */}
      <div className="mt-2.5 flex items-center gap-2 ui-type-sub">
        {project && (
          <Pill
            icon={<FolderTypeIcon size={12} />}
            variant="neutral"
          >
            {project.name}
          </Pill>
        )}
        {task.agentId && <AgentPill agents={agents} agentId={task.agentId} />}
        {employee && (
          <Pill icon={<UserRound className="h-3 w-3" />} variant="accent">
            {employee.name}
          </Pill>
        )}
      </div>

      {/* 时间 */}
      <div className="mt-2 flex items-center gap-1 ui-type-sub text-text-muted">
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
            isFailed
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          }`}
        >
          {isFailed && (
            <IconButton
              icon={<RotateCcw className="h-4 w-4" />}
              label="重试任务"
              tone="accent"
              onClick={(e) => { e.stopPropagation(); onRetry(); }}
            />
          )}
          <ConfirmDeleteButton onConfirm={onDelete} className="rounded-md" iconSize={16} />
        </div>
      )}

      {/* 执行中：旋转图标 + 停止按钮 */}
      {isRunning && (
        <div className="absolute right-2 top-2 flex items-center gap-1">
          <Spinner className="h-4 w-4 text-accent" />
          <IconButton
            icon={<Square className="h-3.5 w-3.5" />}
            label="停止执行"
            tone="danger"
            onClick={(e) => { e.stopPropagation(); onStop(); }}
          />
        </div>
      )}
    </div>
  );
}
