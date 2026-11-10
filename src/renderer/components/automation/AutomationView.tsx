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
import {
  Check, CircleDashed, Clock, ListChecks, Plus } from "lucide-react";
import { useAutomationStore } from "../../stores/automation";
import { useChatStore } from "../../stores/chat";
import { Page, PageHeader } from "../ui/Page";
import { Button } from "../ui/Button";
import { BoardColumn } from "./BoardColumn";
import { TaskCreateModal } from "./TaskCreateModal";
import { TaskDetailDrawer } from "./TaskDetailDrawer";
import type { AutomationTask } from "@shared/types";
import { Spinner } from "../ui/Spinner";

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

  /*
   * detailTask 是打开抽屉时的对象快照；任务状态更新只替换 tasks 里的对象。
   * 直接从最新列表里取同 id 的任务，否则抽屉会永远停在打开时的 running 状态。
   */
  const liveDetailTask = detailTask
    ? (tasks.find((task) => task.id === detailTask.id) ?? detailTask)
    : null;

  return (
    <>
      <Page>
        <PageHeader
          title="任务中心"
          count={tasks.length}
          countSuffix=" 个任务"
          icon={<ListChecks className="h-4 w-4" />}
          actions={
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => setShowCreate(true)}
            >
              新建任务
            </Button>
          }
        />

        {/* 三列看板：列是独立圆角卡片，窄窗口横向滚动 */}
        <div className="relative z-10 flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
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
          {/* 没有任务在跑时不用静止的转圈图标：那看起来像卡住的加载态 */}
          <BoardColumn
            title="执行中"
            count={running.length}
            icon={
              hasRunning ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <CircleDashed className="h-3.5 w-3.5" />
              )
            }
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
      </Page>


      {/* 创建弹框 */}
      {showCreate && <TaskCreateModal onClose={() => setShowCreate(false)} />}

      {/* 详情抽屉 */}
      {liveDetailTask && (
        <TaskDetailDrawer
          task={liveDetailTask}
          onClose={() => setDetailTask(null)}
        />
      )}
    </>
  );
}
