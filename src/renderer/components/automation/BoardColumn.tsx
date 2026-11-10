/**
 * 看板列 — 自动化看板的单列容器（顶部色条 + 列头 + 计数徽章 + 任务卡片列表）
 *
 * 三列以语义色区分身份，由 data-tone 驱动（色相派生见 styles/index.css 的
 * .board-col）：pending=次要文本灰（排队）、running=强调蓝（进行）、
 * done=成功绿（完成）。列头带计数徽章与可选的「新建任务」按钮；
 * 空列时展示 EmptyState 提示。
 */

import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { TaskCard } from "./TaskCard";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import type { AutomationTask, Project } from "@shared/types";
import type { AgentInfo } from "@shared/contracts/agent";

interface ColumnProps {
  title: string;
  count: number;
  icon: ReactNode;
  /** 列身份色相：pending=灰 / running=蓝 / done=绿 */
  tone: "pending" | "running" | "done";
  tasks: AutomationTask[];
  projects: Project[];
  agents: AgentInfo[];
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
  /** 停止执行中的任务（仅 running 卡片会用到） */
  onStop: (id: string) => void;
  onViewDetail: (task: AutomationTask) => void;
  onAdd?: () => void;
  emptyHint: string;
}

export function BoardColumn({
  title, count, icon, tone, tasks, projects, agents,
  onDelete, onRetry, onStop, onViewDetail, onAdd, emptyHint,
}: ColumnProps) {
  return (
    <div
      className="board-col flex h-full min-w-[280px] flex-1 basis-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-surface-2/40 shadow-[var(--c-shadow-sm)]"
      data-tone={tone}
      data-has-items={count > 0 ? "" : undefined}
    >
      {/* 顶部色条 —— 列身份 */}
      <div className="board-col-rail h-[3px] w-full shrink-0" />

      {/* 列头 */}
      <div className="board-col-head flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3.5">
        <div className="board-col-accent flex min-w-0 items-center gap-2">
          {icon}
          <span className="truncate ui-type-body font-semibold">{title}</span>
          <span className="board-col-badge shrink-0 rounded-full px-2 py-0.5 ui-type-code leading-none">
            {count}
          </span>
        </div>
        {onAdd && (
          <IconButton
            icon={<Plus className="h-4 w-4" />}
            label="新建任务"
            size="sm"
            onClick={onAdd}
          />
        )}
      </div>

      {/* 列正文 */}
      <div className="board-col-body min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {tasks.length === 0 &&
          (onAdd ? (
            <button
              type="button"
              onClick={onAdd}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface/40 py-10 text-text-muted transition-colors hover:border-accent/40 hover:bg-accent-soft/30 hover:text-accent"
            >
              <Plus className="h-5 w-5" />
              <span className="ui-type-note">{emptyHint}</span>
            </button>
          ) : (
            <EmptyState size="compact" icon={icon} title={emptyHint} />
          ))}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            project={projects.find((p) => p.id === task.projectId)}
            agents={agents}
            onDelete={() => onDelete(task.id)}
            onRetry={() => onRetry(task.id)}
            onStop={() => onStop(task.id)}
            onViewDetail={() => onViewDetail(task)}
          />
        ))}
      </div>
    </div>
  );
}
