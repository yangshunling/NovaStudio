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
      className="board-col flex h-full w-1/3 min-w-[260px] flex-col border-r border-border last:border-r-0"
      data-tone={tone}
      data-has-items={count > 0 ? "" : undefined}
    >
      {/* 顶部色条 —— 列身份 */}
      <div className="board-col-rail h-[3px] w-full shrink-0" />

      {/* 列头 */}
      <div className="board-col-head flex h-11 shrink-0 items-center justify-between border-b border-border px-inset">
        <div className="board-col-accent flex items-center gap-2">
          {icon}
          <span className="text-body font-semibold">{title}</span>
          <span className="board-col-badge rounded-full px-2 py-0.5 text-caption font-mono leading-none">
            {count}
          </span>
        </div>
        {onAdd && (
          <button
            onClick={onAdd}
            title="新建任务"
            className="ui-btn-round ui-icon-action flex h-7 w-7 items-center justify-center rounded-full"
          >
            <Plus className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* 列正文 */}
      <div className="board-col-body flex-1 space-y-2.5 overflow-y-auto p-inset">
        {tasks.length === 0 && <EmptyState icon={icon} title={emptyHint} className="py-12" />}
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
