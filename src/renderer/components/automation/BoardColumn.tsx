/**
 * 看板列 — 自动化看板的单列容器（顶部色条 + 列头 + 计数徽章 + 任务卡片列表）
 *
 * 各列以语义色区分身份，由 data-tone 驱动（色相派生见 styles/index.css 的
 * .board-col）：pending=次要文本灰（排队）、running=强调蓝（进行）、
 * done=成功绿（完成）。列头带计数徽章与可选的「新建任务」按钮；
 * 空列时展示 EmptyState 提示。
 */

import type { ReactNode } from "react";
import { TaskCard } from "./TaskCard";
import { EmptyState } from "../ui/EmptyState";
import type { AutomationTask, Project } from "@shared/types";
import type { AgentInfo } from "@shared/contracts/agent";

interface ColumnProps {
  title: string;
  count: number;
  icon: ReactNode;
  /** 列身份色相：pending=灰 / running=蓝 / failed=红 / done=绿 */
  tone: "pending" | "running" | "failed" | "done";
  tasks: AutomationTask[];
  projects: Project[];
  agents: AgentInfo[];
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
  /** 停止执行中的任务（仅 running 卡片会用到） */
  onStop: (id: string) => void;
  onViewDetail: (task: AutomationTask) => void;
  emptyHint: string;
  /** 列表分页 / 加载更多等列尾操作 */
  footer?: ReactNode;
}

export function BoardColumn({
  title, count, icon, tone, tasks, projects, agents,
  onDelete, onRetry, onStop, onViewDetail, emptyHint, footer,
}: ColumnProps) {
  return (
    <div
      className="board-col flex h-full min-w-[280px] flex-1 basis-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-2/40"
      data-tone={tone}
    >
      {/* 列身份：顶部 2px 语义色，其余保持中性 */}
      <div className="board-col-rail h-0.5 w-full shrink-0" />

      {/* 列头 */}
      <div className="board-col-head flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="board-col-accent flex min-w-0 items-center gap-2">
          {icon}
          <span className="truncate ui-type-body font-medium">{title}</span>
          <span className="board-col-badge shrink-0 ui-type-sub tabular-nums">
            {count}
          </span>
        </div>
      </div>

      {/* 列正文 */}
      <div className="board-col-body min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {tasks.length === 0 && (
          <EmptyState size="compact" icon={icon} title={emptyHint} />
        )}
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
        {footer}
      </div>
    </div>
  );
}
