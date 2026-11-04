/**
 * 左侧导航栏 — 品牌 / 功能入口 / 设置
 *
 * 项目与会话列表已迁到「会话管理」页面（SessionListPanel），
 * 这里只保留全局功能入口；新建会话在会话列表右上角。
 */

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../stores/chat";
import { ipc } from "../lib/ipc";
import { toast } from "../stores/toast";
import type { WorkflowRun } from "@shared/types";
import {
  AlarmClock,
  Bot,
  ChevronRight,
  Library,
  FolderKanban,
  MessageSquare,
  Plug,
  Settings,
  Sparkles,
  SquareTerminal,
  Users,
  Waypoints,
  Workflow,
} from "lucide-react";
import logoUrl from "../assets/logo.png";
import { ThemeToggle } from "./ThemeToggle";

/** 导航项字号 */
const FONT_BODY = "text-body-lg";

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

  useEffect(() => {
    let alive = true;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const runs = await ipc.listActiveWorkflowRuns();
        if (!alive) return;
        setActiveRuns(runs);

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
        // 提示失败不影响导航
      }
    };

    void load();
    const off = ipc.on.workflowRunEvent(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void load(), 200);
    });
    const timer = setInterval(() => {
      if (activeRunsRef.current.length > 0) void load();
    }, 3000);

    return () => {
      alive = false;
      if (debounce) clearTimeout(debounce);
      clearInterval(timer);
      off();
    };
  }, []);

  const awaitingCount = activeRuns.filter(
    (run) => run.status === "awaiting_approval",
  ).length;

  const itemClass = (active: boolean) =>
    `flex w-full items-center gap-2 rounded-md px-2.5 py-2.5 ${FONT_BODY} font-medium transition-colors ${
      active
        ? "bg-surface-active text-text shadow-[var(--c-shadow-sm)]"
        : "text-text-secondary hover:bg-surface-hover hover:text-text"
    }`;

  return (
    <aside className="ui-sidebar relative flex h-full w-[var(--c-layout-sidebar)] flex-col border-r-0">
      {/* 头部：品牌 */}
      <div
        style={{ zIndex: 30 }}
        className="relative flex h-[var(--c-layout-header)] items-center justify-between gap-2 border-b border-border px-4"
      >
        <div className="flex min-w-0 items-center gap-2">
          <img
            src={logoUrl}
            alt="Nova Studio"
            className="h-8 w-8 shrink-0 rounded-lg object-cover"
          />
          {/* 标题与 logo / 切换按钮共用 32px 行盒，并压掉多余行高，
              避免文字行盒高度与图标不一致导致视觉上偏上。 */}
          <span className="flex h-8 min-w-0 items-center">
            <span className="min-w-0 truncate text-title font-semibold leading-none tracking-wide text-text">
              Nova Studio
            </span>
          </span>
        </div>
        <ThemeToggle />
      </div>

      {/* 功能分组 */}
      <div className="px-3 pt-3 pb-1">
        <span className="px-1 text-meta font-medium tracking-wide text-text-muted">功能</span>
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
          onClick={() => setViewMode("terminals")}
          className={itemClass(viewMode === "terminals")}
        >
          <SquareTerminal className="h-4 w-4 shrink-0" />
          终端管理
        </button>
        <button
          type="button"
          onClick={() => setViewMode("automation")}
          className={itemClass(viewMode === "automation")}
        >
          <Workflow className="h-4 w-4 shrink-0" />
          任务中心
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
              className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-caption font-medium ${
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
          onClick={() => setViewMode("employees")}
          className={itemClass(viewMode === "employees")}
        >
          <Users className="h-4 w-4 shrink-0" />
          数字员工
        </button>
      </div>

      {/* 资产分组 */}
      <div className="px-3 pt-4 pb-1">
        <span className="px-1 text-meta font-medium tracking-wide text-text-muted">资产</span>
      </div>
      <div className="space-y-1 px-2.5 pb-2">
        <button
          type="button"
          onClick={() => setViewMode("skills")}
          className={itemClass(viewMode === "skills")}
        >
          <Sparkles className="h-4 w-4 shrink-0" />
          Skill
        </button>
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
          onClick={() => setViewMode("knowledge")}
          className={itemClass(viewMode === "knowledge")}
        >
          <Library className="h-4 w-4 shrink-0" />
          知识库
        </button>
        <button
          type="button"
          onClick={() => setViewMode("workspaces")}
          className={itemClass(viewMode === "workspaces")}
        >
          <FolderKanban className="h-4 w-4 shrink-0" />
          工作区
        </button>
      </div>

      {/* 运行时分组 */}
      <div className="px-3 pt-4 pb-1">
        <span className="px-1 text-meta font-medium tracking-wide text-text-muted">
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

      {/* 底部：设置入口 */}
      <div className="relative mt-auto border-t border-border p-2.5">
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
          <span className="min-w-0 flex-1 truncate text-body font-medium text-text">
            设置
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>
    </aside>
  );
}
