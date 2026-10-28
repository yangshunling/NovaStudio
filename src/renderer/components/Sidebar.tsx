/**
 * 左侧导航栏 — 品牌 / 功能入口 / 设置
 *
 * 项目与会话列表已迁到「会话管理」页面（SessionListPanel），
 * 这里只保留全局功能入口；新建会话在会话列表右上角。
 */

import { useChatStore } from "../stores/chat";
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
          <span className="truncate text-title font-semibold tracking-wide text-text">
            Nova Studio
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

      {/* 运行环境分组 */}
      <div className="px-3 pt-4 pb-1">
        <span className="px-1 text-meta font-medium tracking-wide text-text-muted">
          运行环境
        </span>
      </div>
      <div className="space-y-1 px-2.5 pb-2">
        <button
          type="button"
          onClick={() => setViewMode("agents")}
          className={itemClass(viewMode === "agents")}
        >
          <Bot className="h-4 w-4 shrink-0" />
          Agent 平台
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
