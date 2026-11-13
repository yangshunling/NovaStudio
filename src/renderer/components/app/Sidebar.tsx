/**
 * 左侧导航栏 — 品牌 / 分组入口（个人、工程、资产、运行时）/ 设置
 *
 * 项目与会话列表已迁到「会话管理」页面（SessionListPanel），
 * 这里只保留全局功能入口；新建会话在会话列表右上角。
 */

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../../stores/chat";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toast";
import sloganUrl from "../../assets/slogan.png";
import type { WorkflowRun } from "@shared/types";
import {
  AlarmClock,
  Bot,
  ChevronRight,
  Library,
  FolderKanban,
  ListTodo,
  MessageSquare,
  MessageSquareText,
  Plug,
  Settings,
  Sparkles,
  Users,
  Waypoints,
  Workflow,
} from "lucide-react";

/** 导航项字号 */
const FONT_BODY = "ui-type-item";

export function Sidebar() {
  const viewMode = useChatStore((s) => s.viewMode);
  const setViewMode = useChatStore((s) => s.setViewMode);
  const setShowSettings = useChatStore((s) => s.setShowSettings);
  const showSettings = useChatStore((s) => s.showSettings);

  /*
   * 全局活跃运行提示。
   * 工作流/触发器页面按需挂载，切走后就收不到运行事件；侧栏常驻，
   * 在这里维护一份活跃运行快照，至少保证“正在跑 / 等待审核”不会被藏起来。
   */
  const [activeRuns, setActiveRuns] = useState<WorkflowRun[]>([]);
  const activeRunsRef = useRef<WorkflowRun[]>([]);
  activeRunsRef.current = activeRuns;
  const knownAwaiting = useRef<Set<string> | null>(null);
  /** 刷新失败只提示一次：否则 3 秒一次的轮询会不断刷屏 */
  const errorReported = useRef(false);

  useEffect(() => {
    let alive = true;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const runs = await ipc.listActiveWorkflowRuns();
        if (!alive) return;
        setActiveRuns(runs);
        errorReported.current = false;

        const awaiting = new Set(
          runs
            .filter((run) => run.status === "awaiting_approval")
            .map((run) => run.id),
        );
        if (knownAwaiting.current === null) {
          knownAwaiting.current = awaiting;
        } else {
          const hasNew = [...awaiting].some(
            (id) => !knownAwaiting.current!.has(id),
          );
          knownAwaiting.current = awaiting;
          if (hasNew) toast.info("有工作流节点等待审核");
        }
      } catch {
        // 状态刷新失败不能静默：用户会以为没有运行中的工作流
        if (!errorReported.current) {
          errorReported.current = true;
          toast.error("工作流运行状态刷新失败，正在显示上次结果", 5000);
        }
      }
    };

    void load();
    const off = ipc.on.workflowRunEvent(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void load(), 200);
    });
    // 推送是主链路；轮询只做兜底，10 秒足够发现漏掉的终态，避免空闲耗电
    const timer = setInterval(() => {
      if (activeRunsRef.current.length > 0) void load();
    }, 10_000);

    return () => {
      alive = false;
      if (debounce) clearTimeout(debounce);
      clearInterval(timer);
      off();
    };
  }, []);

  /* 待办未完成数量：进入应用时拉一次，之后由主进程推送更新 */
  const [pendingTodos, setPendingTodos] = useState(0);

  useEffect(() => {
    let alive = true;
    ipc
      .listTodos()
      .then((items) => {
        if (alive) setPendingTodos(items.filter((item) => !item.done).length);
      })
      .catch(() => {
        // 角标失败不影响导航
      });
    const off = ipc.on.todosChanged(({ pending }) => setPendingTodos(pending));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const awaitingCount = activeRuns.filter(
    (run) => run.status === "awaiting_approval",
  ).length;

  const itemClass = (active: boolean) =>
    `relative flex w-full items-center gap-2 rounded-lg px-2.5 py-2 ${FONT_BODY} transition-colors ${
      active
        ? "bg-selected font-medium text-text before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[2px] before:-translate-y-1/2 before:rounded-full before:bg-accent"
        : "text-text-secondary hover:bg-surface-hover/70 hover:text-text"
    }`;

  return (
    <aside className="ui-sidebar relative flex h-full w-[var(--c-layout-sidebar)] flex-col border-r-0">
      {/* 头部：标语图品牌「Work is Agentic」（透明底 PNG，无 icon）。
          皮肤切换已移入「设置 → 外观」，刊头独占整行，因此居中排布。 */}
      <div
        style={{ zIndex: 30 }}
        className="relative flex h-[var(--c-layout-header)] items-center justify-center overflow-hidden border-b border-border px-8"
      >
        {/* 图片按 4x 导出（768×110）；左右各留 32px，可用宽 152px，等比显示为 152×21.8。
            宽度撑满而不是固定高度：素材就是按这个尺寸做的，避免再次降采样。 */}
        <div className="relative flex w-full min-w-0 items-center justify-center">
          <img
            src={sloganUrl}
            alt="Work is Agentic"
            draggable={false}
            className="h-auto w-full select-none"
          />
        </div>
      </div>

      {/* 导航区：窗口较矮时可滚动，保证底部设置入口始终可见 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 个人分组 */}
        <div className="px-3 pt-3 pb-1">
        <span className="px-1 ui-type-note font-semibold tracking-wide text-text-muted">个人</span>
      </div>
      <div className="space-y-1 px-2.5 pb-2">
        <button
          type="button"
          onClick={() => setViewMode("chat")}
          className={itemClass(viewMode === "chat")}
        >
          <MessageSquare className="h-4 w-4 shrink-0" />
          会话管理
        </button>
        <button
          type="button"
          onClick={() => setViewMode("todos")}
          className={itemClass(viewMode === "todos")}
        >
          <ListTodo className="h-4 w-4 shrink-0" />
          待办事项
          {pendingTodos > 0 && (
            <span
              title={`${pendingTodos} 件待办未完成`}
              className="ml-auto shrink-0 rounded-full bg-accent-soft px-2 py-0.5 ui-type-label text-accent"
            >
              {pendingTodos}
            </span>
          )}
        </button>
      </div>

      {/* 工程分组 */}
      <div className="px-3 pt-4 pb-1">
        <span className="px-1 ui-type-note font-semibold tracking-wide text-text-muted">工程</span>
      </div>
      <div className="space-y-1 px-2.5 pb-2">
        <button
          type="button"
          onClick={() => setViewMode("workspaces")}
          className={itemClass(viewMode === "workspaces")}
        >
          <FolderKanban className="h-4 w-4 shrink-0" />
          工作区
        </button>
        <button
          type="button"
          onClick={() => setViewMode("workflow")}
          className={itemClass(viewMode === "workflow")}
        >
          <Waypoints className="h-4 w-4 shrink-0" />
          工作流
          {activeRuns.length > 0 && (
            <span
              title={
                awaitingCount > 0
                  ? `${awaitingCount} 个运行等待审核`
                  : `${activeRuns.length} 个工作流正在运行`
              }
              className={`ml-auto shrink-0 rounded-full px-2 py-0.5 ui-type-label ${
                awaitingCount > 0
                  ? "bg-accent-soft text-accent"
                  : "bg-surface-hover text-text-muted"
              }`}
            >
              {awaitingCount > 0 ? `${awaitingCount} 待审` : `${activeRuns.length} 运行`}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setViewMode("triggers")}
          className={itemClass(viewMode === "triggers")}
        >
          <AlarmClock className="h-4 w-4 shrink-0" />
          触发器
        </button>
        <button
          type="button"
          onClick={() => setViewMode("automation")}
          className={itemClass(viewMode === "automation")}
        >
          <Workflow className="h-4 w-4 shrink-0" />
          自动化任务
        </button>
        <button
          type="button"
          onClick={() => setViewMode("employees")}
          className={itemClass(viewMode === "employees")}
        >
          <Users className="h-4 w-4 shrink-0" />
          数字员工
        </button>
      </div>

      {/* 资产分组 */}
      <div className="px-3 pt-4 pb-1">
        <span className="px-1 ui-type-note font-semibold tracking-wide text-text-muted">资产</span>
      </div>
      <div className="space-y-1 px-2.5 pb-2">
        <button
          type="button"
          onClick={() => setViewMode("mcp")}
          className={itemClass(viewMode === "mcp")}
        >
          <Plug className="h-4 w-4 shrink-0" />
          MCP
        </button>
        <button
          type="button"
          onClick={() => setViewMode("skills")}
          className={itemClass(viewMode === "skills")}
        >
          <Sparkles className="h-4 w-4 shrink-0" />
          SKILL
        </button>
        <button
          type="button"
          onClick={() => setViewMode("prompts")}
          className={itemClass(viewMode === "prompts")}
        >
          <MessageSquareText className="h-4 w-4 shrink-0" />
          提示词
        </button>
        <button
          type="button"
          onClick={() => setViewMode("knowledge")}
          className={itemClass(viewMode === "knowledge")}
        >
          <Library className="h-4 w-4 shrink-0" />
          知识库
        </button>
      </div>

      {/* 运行时分组 */}
      <div className="px-3 pt-4 pb-1">
        <span className="px-1 ui-type-note font-semibold tracking-wide text-text-muted">
          运行时
        </span>
      </div>
      <div className="space-y-1 px-2.5 pb-2">
        <button
          type="button"
          onClick={() => setViewMode("agents")}
          className={itemClass(viewMode === "agents")}
        >
          <Bot className="h-4 w-4 shrink-0" />
          Agent 配置
        </button>
      </div>

      </div>

      {/* 底部：设置入口 */}
      <div className="relative shrink-0 border-t border-border p-2.5">
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className={`ui-ring group flex w-full items-center gap-2.5 rounded-lg bg-input-bg px-inset py-2 text-left outline-none transition-all hover:border-input-border-focus focus:border-input-border-focus ${
            showSettings ? "border-input-border-focus" : ""
          }`}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
            <Settings className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1 truncate ui-type-body font-medium text-text">
            设置
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>
    </aside>
  );
}
