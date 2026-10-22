/**
 * 自动化看板 — 三列看板式任务管理
 *
 * 列 1「待执行」：录入自然语言任务，绑定项目 + Agent，可删除；等待被轮询器拾取
 * 列 2「执行中」：主进程轮询器自动拾取 pending 任务并发执行，可停止、不可删除；
 *                执行失败 / 被停止的任务也停留在这一列（失败态 + 手动重试）
 * 列 3「已完成」：成功执行完毕，可删除 / 重试 / 查看详情
 *
 * UI 参考 Linear / GitHub Projects 的看板设计：
 * - 竖直列布局，三列横向并排
 * - 卡片式任务，hover 显示操作按钮
 * - 状态色编码（pending=muted, running=accent pulse, completed=success, failed=error）
 * - 列头带计数徽章
 *
 * 子组件拆分：
 * - BoardColumn（看板列）
 * - TaskCard（任务卡片）
 * - TaskCreateModal（任务创建弹框）
 * - TaskDetailDrawer（任务详情抽屉）
 */

import { useState } from "react";
import { Clock, Check, Loader2 } from "lucide-react";
import { useAutomationStore } from "../stores/automation";
import { useChatStore } from "../stores/chat";
import { SkinStage } from "./SkinStage";
import { BoardColumn } from "./automation/BoardColumn";
import { TaskCreateModal } from "./automation/TaskCreateModal";
import { TaskDetailDrawer } from "./automation/TaskDetailDrawer";
import type { AutomationTask } from "@shared/types";

// ============================================================================
// 自动化看板主组件
// ============================================================================

export function AutomationView() {
  const tasks = useAutomationStore((s) => s.tasks);
  const deleteTask = useAutomationStore((s) => s.deleteTask);
  const retryTask = useAutomationStore((s) => s.retryTask);
  const stopTask = useAutomationStore((s) => s.stopTask);
  const projects = useChatStore((s) => s.projects);
  const agents = useChatStore((s) => s.agents);

  const [showCreate, setShowCreate] = useState(false);
  const [detailTask, setDetailTask] = useState<AutomationTask | null>(null);

  const pending = tasks.filter((t) => t.status === "pending");
  // 失败/被停止的任务留在执行中列等待手动重试（它们不占用并发槽位）
  const running = tasks.filter((t) => t.status === "running" || t.status === "failed");
  const done = tasks.filter((t) => t.status === "completed");
  // 列头转圈只反映"真的有进程在跑"
  const hasRunning = tasks.some((t) => t.status === "running");

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      {/* 背景 */}
      <SkinStage />

      {/* 主体纸面：顶栏 + 看板同属一张纸，浮在画布底色之上 */}
      <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden rounded-xl">
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <span className="ui-serif text-title font-semibold tracking-wide text-text-secondary">任务中心</span>
            <span className="rounded-full bg-surface-hover px-2 py-0.5 text-caption font-mono text-text-muted">
              {tasks.length} 个任务
            </span>
          </div>
        </header>

        {/* 三列看板 */}
        <div className="relative z-10 flex flex-1 overflow-hidden">
          <BoardColumn
            title="待执行"
            count={pending.length}
            icon={<Clock className="h-3.5 w-3.5" />}
            tone="pending"
            tasks={pending}
            projects={projects}
            agents={agents}
            onDelete={deleteTask}
            onRetry={retryTask}
            onStop={stopTask}
            onViewDetail={setDetailTask}
            onAdd={() => setShowCreate(true)}
            emptyHint="暂无待执行任务"
          />
          <BoardColumn
            title="执行中"
            count={running.length}
            icon={<Loader2 className={`h-4 w-4 ${hasRunning ? "animate-spin" : ""}`} />}
            tone="running"
            tasks={running}
            projects={projects}
            agents={agents}
            onDelete={deleteTask}
            onRetry={retryTask}
            onStop={stopTask}
            onViewDetail={setDetailTask}
            emptyHint="当前无执行中任务"
          />
          <BoardColumn
            title="已完成"
            count={done.length}
            icon={<Check className="h-3.5 w-3.5" />}
            tone="done"
            tasks={done}
            projects={projects}
            agents={agents}
            onDelete={deleteTask}
            onRetry={retryTask}
            onStop={stopTask}
            onViewDetail={setDetailTask}
            emptyHint="尚无已完成任务"
          />
        </div>
      </div>

      {/* 创建弹框 */}
      {showCreate && <TaskCreateModal onClose={() => setShowCreate(false)} />}

      {/* 详情抽屉 */}
      {detailTask && <TaskDetailDrawer task={detailTask} onClose={() => setDetailTask(null)} />}
    </main>
  );
}
