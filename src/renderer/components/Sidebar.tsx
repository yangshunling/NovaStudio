/**
 * 侧边栏 — 项目 → 会话 树
 *
 * 交互：
 *   点 + → 直接弹原生文件夹选择器 → 用文件夹名当项目名创建（无需命名）
 *   项目可折叠；会话点击切换，hover 删除，运行中显示停止按钮
 *
 * 字号/间距偏大，保证最小点击区 ~36px，移动鼠标不费力。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStore } from "../stores/chat";
import {
  Trash2,
  Check,
  ChevronRight,
  PenLine,
  Square,
  Workflow,
  Settings,
  MoreHorizontal,
  Eraser,
  FolderPlus,
  SquareTerminal,
  Waypoints,
  Users,
} from "lucide-react";
import type { Project, Session } from "@shared/types";
import type { AgentInfo } from "@shared/contracts/agent";
import logoUrl from "../assets/logo.png";
import { timeAgo } from "../lib/utils";
import { AgentPill } from "./ui/AgentPill";
import { ConfirmDeleteButton } from "./ui/ConfirmDeleteButton";
import { FolderTypeIcon } from "./ui/FolderTypeIcon";
import { StatusDot } from "./ui/StatusDot";
import { useFileViewerStore } from "../stores/fileViewer";

/** 取路径最后一段当项目名（兼容 Windows 反斜杠） */
function dirName(p: string): string {
  if (!p) return "未命名";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** 侧栏正文与元信息字号 */
const FONT_BODY = "text-body-lg";
const FONT_META = "text-meta";

export function Sidebar() {
  const projects = useChatStore((s) => s.projects);
  const sessions = useChatStore((s) => s.sessions);
  const agents = useChatStore((s) => s.agents);
  const currentProjectId = useChatStore((s) => s.currentProjectId);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const streamingBySession = useChatStore((s) => s.streamingBySession);
  const viewMode = useChatStore((s) => s.viewMode);
  const setViewMode = useChatStore((s) => s.setViewMode);
  const setShowSettings = useChatStore((s) => s.setShowSettings);
  const showSettings = useChatStore((s) => s.showSettings);
  const openTerminal = useFileViewerStore((s) => s.openTerminal);
  const {
    selectSession,
    selectProject,
    deleteSession,
    createProject,
    deleteProject,
    clearProjectSessions,
    renameSession,
    pickDirectory,
    abort,
  } = useChatStore();

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpand = (id: string) =>
    setExpanded((m) => ({ ...m, [id]: m[id] === undefined ? false : !m[id] }));

  // 新建项目：直接选文件夹，用文件夹名当项目名；若该目录已是项目则切换过去
  const handleNewProject = async () => {
    const cwd = await pickDirectory();
    if (!cwd) return;
    const existing = projects.find((p) => p.cwd === cwd);
    if (existing) {
      selectProject(existing.id);
      return;
    }
    await createProject(dirName(cwd), cwd);
  };

  /** 在指定项目目录下新建终端，并切到该项目的对话视图 */
  const handleProjectTerminal = (project: Project) => {
    selectProject(project.id);
    openTerminal(project.cwd);
    setViewMode("chat");
  };

  // 点击项目主体：选中该项目 + 切到对话视图 + 进入新会话态（首条消息时才真正建会话，
  // 避免产生空会话）。同时确保该项目展开，让用户能看到其下会话列表。
  const handleSelectProject = (id: string) => {
    selectProject(id);
    setViewMode("chat");
    setExpanded((m) => (m[id] === false ? { ...m, [id]: true } : m));
  };

  return (
    <aside className="ui-sidebar relative flex h-full w-[var(--c-layout-sidebar)] flex-col border-r-0">
      {/* 头部：品牌 */}
      <div
        style={{ zIndex: 30 }}
        className="relative flex h-[var(--c-layout-header)] items-center border-b border-border px-4"
      >
        <div className="flex items-center gap-2">
          <img
            src={logoUrl}
            alt="Nova Studio"
            className="h-8 w-8 rounded-lg object-cover"
          />
          <span className="text-title font-semibold tracking-wide text-text">Nova Studio</span>
        </div>
      </div>

      {/* 功能分组 */}
      <div className="px-3 pt-3 pb-1">
        <span className={`px-1 ${FONT_META} font-medium tracking-wide text-text-muted`}>功能</span>
      </div>
      <div className="space-y-1 px-2.5 pb-2">
        <button
          onClick={handleNewProject}
          title="选择文件夹新建项目"
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2.5 text-body-lg font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
        >
          <FolderPlus className="h-4 w-4 shrink-0" />
          新建项目
        </button>
        <button
          onClick={() => setViewMode("automation")}
          className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2.5 text-body-lg font-medium transition-colors ${
            viewMode === "automation"
              ? "ui-active bg-surface-active text-text"
              : "text-text-secondary hover:bg-surface-hover hover:text-text"
          }`}
        >
          <Workflow className="h-4 w-4 shrink-0" />
          任务中心
        </button>
        <button
          type="button"
          title="工作流（规划中，暂未开放）"
          className="flex w-full cursor-default items-center gap-2 rounded-md px-2.5 py-2.5 text-body-lg font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Waypoints className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 text-left">工作流</span>
          <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-caption font-normal text-text-muted">
            规划中
          </span>
        </button>
        <button
          type="button"
          onClick={() => setViewMode("employees")}
          className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2.5 text-body-lg font-medium transition-colors ${
            viewMode === "employees"
              ? "ui-active bg-surface-active text-text"
              : "text-text-secondary hover:bg-surface-hover hover:text-text"
          }`}
        >
          <Users className="h-4 w-4 shrink-0" />
          数字员工
        </button>
      </div>

      {/* 项目分组 */}
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className={`px-1 ${FONT_META} font-medium tracking-wide text-text-muted`}>项目</span>
      </div>

      {/* 项目 + 会话树（内容超出时仍可滚动，但不显示滚动条） */}
      <div className="ui-scroll-hidden flex-1 overflow-y-auto px-2.5 py-1">
        {projects.length === 0 && (
          <div className="px-2 py-10 text-center">
            <FolderTypeIcon
              size={24}
              toneClassName="text-text-muted"
              className="mx-auto mb-3"
            />
            <p className={`mb-3 ${FONT_META} text-text-muted`}>还没有项目</p>
            <button
              onClick={handleNewProject}
              className="text-body-lg font-medium text-accent hover:text-accent-hover"
            >
              + 选择文件夹新建
            </button>
          </div>
        )}

        <div className="space-y-1">
          {projects.map((project) => (
            <ProjectNode
              key={project.id}
              project={project}
              sessions={sessions.filter((s) => s.projectId === project.id)}
              streamingBySession={streamingBySession}
              agents={agents}
              isExpanded={expanded[project.id] ?? true}
              onToggle={() => toggleExpand(project.id)}
              onSelect={() => handleSelectProject(project.id)}
              activeSessionId={viewMode === "chat" ? currentSessionId : null}
              isActiveProject={viewMode === "chat" && currentProjectId === project.id}
              onOpenSession={(id) => {
                selectSession(id);
                setViewMode("chat");
              }}
              onDeleteSession={(id) => deleteSession(id)}
              onAbortSession={(id) => abort(id)}
              onRenameSession={(id, title) => renameSession(id, title)}
              onNewTerminal={() => handleProjectTerminal(project)}
              onClearSessions={() => {
                if (
                  window.confirm(
                    `清空项目「${project.name}」下的全部会话？此操作不可恢复。`,
                  )
                ) {
                  clearProjectSessions(project.id);
                }
              }}
              onDeleteProject={() => {
                if (window.confirm(`删除项目「${project.name}」及其所有会话？`)) {
                  deleteProject(project.id);
                }
              }}
            />
          ))}
        </div>
      </div>

      {/* 底部：设置入口 */}
      <div className="relative border-t border-border p-inset">
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className={`ui-ring group flex w-full items-center gap-2.5 rounded-lg bg-input-bg px-inset py-inset text-left outline-none transition-all hover:border-input-border-focus focus:border-input-border-focus ${
            showSettings ? "border-input-border-focus" : ""
          }`}
        >
          <span className="flex size-avatar shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
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

// ============================================================================
// 项目节点：可折叠，展开显示会话
// ============================================================================

function ProjectNode({
  project,
  sessions,
  streamingBySession,
  agents,
  isExpanded,
  onToggle,
  onSelect,
  activeSessionId,
  isActiveProject,
  onOpenSession,
  onDeleteSession,
  onAbortSession,
  onRenameSession,
  onNewTerminal,
  onClearSessions,
  onDeleteProject,
}: {
  project: Project;
  sessions: Session[];
  streamingBySession: Record<string, boolean>;
  agents: AgentInfo[];
  isExpanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
  activeSessionId: string | null;
  isActiveProject: boolean;
  onOpenSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onAbortSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onNewTerminal: () => void;
  onClearSessions: () => void;
  onDeleteProject: () => void;
}) {
  return (
    <div>
      {/* 项目头：折叠箭头与选中主体分开 —— 点箭头只折叠，点主体才选中项目 */}
      <div
        className={`group/proj flex items-center gap-1 rounded-lg px-1.5 ${
          isActiveProject ? "bg-surface-active" : "hover:bg-surface-hover"
        }`}
      >
        <button
          onClick={onToggle}
          title={isExpanded ? "折叠" : "展开"}
          aria-expanded={isExpanded}
          className="flex shrink-0 items-center justify-center py-2.5 text-text-muted hover:text-text"
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
        </button>
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-2.5 text-left"
          title={project.cwd || project.name}
        >
          <FolderTypeIcon open={isExpanded} />
          <span className={`min-w-0 flex-1 truncate ${FONT_BODY} font-medium`}>
            {project.name}
          </span>
        </button>
        {/* 项目操作：⋯ 菜单（新建终端 / 清空会话 / 删除项目） */}
        <div className="flex shrink-0 items-center gap-0.5">
          <ProjectMenu
            sessionCount={sessions.length}
            onNewTerminal={onNewTerminal}
            onClearSessions={onClearSessions}
            onDeleteProject={onDeleteProject}
          />
        </div>
      </div>

      {/* 会话列表 */}
      {isExpanded && (
        <div className="ml-3 space-y-2 border-l border-border pl-2 pt-2">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              isStreaming={!!streamingBySession[session.id]}
              agents={agents}
              onOpen={() => onOpenSession(session.id)}
              onDelete={() => onDeleteSession(session.id)}
              onAbort={() => onAbortSession(session.id)}
              onRename={(title) => onRenameSession(session.id, title)}
            />
          ))}
          {/* 空态 */}
          {sessions.length === 0 && (
            <p className={`px-2 py-1.5 ${FONT_META} text-text-muted`}>无会话</p>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 项目操作菜单：新建终端 / 清空所有会话 / 删除项目
// ============================================================================

/** 面板宽度：定位要按它右对齐到按钮，单独定义避免与 class 里的宽度写重 */
const MENU_WIDTH = 192;
/** 面板高度估算：用于贴近窗口底部时向上翻转，避免被视口裁掉 */
const MENU_HEIGHT = 160;

/**
 * 「⋯」菜单。面板用 fixed 定位挂在按钮下方 —— 侧栏会话树本身是滚动容器，
 * 绝对定位的下拉会被 overflow 裁掉（最后一个项目尤其明显）。
 */
function ProjectMenu({
  sessionCount,
  onNewTerminal,
  onClearSessions,
  onDeleteProject,
}: {
  sessionCount: number;
  onNewTerminal: () => void;
  onClearSessions: () => void;
  onDeleteProject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // 展开时：外部点击 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 展开后若会超出窗口底部，则改为向上展开
    const top =
      rect.bottom + 4 + MENU_HEIGHT > window.innerHeight - 8
        ? Math.max(8, rect.top - MENU_HEIGHT - 4)
        : rect.bottom + 4;
    setPos({ top, left: Math.max(8, rect.right - MENU_WIDTH) });
    setOpen(true);
  };

  // 行高按侧栏「最小点击区 ~36px+」的约定给足，鼠标不必瞄准
  const itemClass =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-3 text-left text-body transition-colors";

  return (
    // 注意：淡入淡出只加在按钮上，不能加在这个容器上 ——
    // 祖先元素 opacity < 1 会给 fixed 面板制造新的包含块，定位会跳一下。
    <div ref={rootRef} className="relative shrink-0">
      {open && (
        <div
          style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
          className="ui-dropdown-in ui-glass-strong ui-ring fixed z-50 space-y-0.5 rounded-xl p-1.5"
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNewTerminal();
            }}
            className={`${itemClass} text-text-secondary hover:bg-surface-hover hover:text-text`}
          >
            <SquareTerminal className="h-4 w-4 shrink-0 text-accent" />
            新建终端
          </button>

          <div className="my-1 h-px bg-border" />

          <button
            type="button"
            disabled={sessionCount === 0}
            onClick={() => {
              setOpen(false);
              onClearSessions();
            }}
            title={sessionCount === 0 ? "该项目下没有会话" : "一键删除该项目下的全部会话"}
            className={`${itemClass} text-text-secondary hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-secondary`}
          >
            <Eraser className="h-4 w-4 shrink-0" />
            清空所有会话
            {sessionCount > 0 && (
              <span
                title={`${sessionCount} 个会话`}
                className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 font-mono text-caption font-semibold text-accent-foreground"
              >
                {sessionCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onDeleteProject();
            }}
            className={`${itemClass} text-error hover:bg-error-bg`}
          >
            <Trash2 className="h-4 w-4 shrink-0" />
            删除项目
          </button>
        </div>
      )}
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title="项目操作"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`rounded p-2 text-text-muted transition-opacity hover:bg-surface-hover hover:text-text ${
          open ? "opacity-100 text-text" : "opacity-0 group-hover/proj:opacity-100 focus-within:opacity-100"
        }`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
    </div>
  );
}

// ============================================================================
// 会话行：单行布局 — 标题常驻，Agent 标记与时间悬浮显示
// ============================================================================

function SessionRow({
  session,
  isActive,
  isStreaming,
  agents,
  onOpen,
  onDelete,
  onAbort,
  onRename,
}: {
  session: Session;
  isActive: boolean;
  isStreaming: boolean;
  agents: AgentInfo[];
  onOpen: () => void;
  onDelete: () => void;
  onAbort: () => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const rowRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const metaAnchorRef = useRef<{
    centerX: number;
    top: number;
    bottom: number;
  } | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [metaReady, setMetaReady] = useState(false);
  const [metaRevision, setMetaRevision] = useState(0);
  const [metaPos, setMetaPos] = useState<{
    left: number;
    top: number;
    placement: "top" | "bottom";
  }>({ left: 0, top: 0, placement: "top" });

  const startEdit = () => {
    setMetaOpen(false);
    setEditTitle(session.title);
    setEditing(true);
  };
  const submitEdit = () => {
    const t = editTitle.trim();
    if (t && t !== session.title) onRename(t);
    setEditing(false);
  };

  const showMetadata = () => {
    const rect = rowRef.current?.getBoundingClientRect();
    if (!rect) return;
    const estimatedHeight = 38;
    const gap = 10;
    const placement: "top" | "bottom" =
      rect.top >= estimatedHeight + gap ? "top" : "bottom";
    metaAnchorRef.current = {
      centerX: rect.left + rect.width / 2,
      top: rect.top,
      bottom: rect.bottom,
    };
    setMetaReady(false);
    setMetaRevision((value) => value + 1);
    setMetaPos({
      left: 0,
      top: -1000,
      placement,
    });
    setMetaOpen(true);
  };

  useLayoutEffect(() => {
    if (!metaOpen) return;
    const popup = popupRef.current;
    const anchor = metaAnchorRef.current;
    if (!popup || !anchor) return;

    const gap = 10;
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    const left = Math.round(
      Math.max(
        8,
        Math.min(
          window.innerWidth - width - 8,
          anchor.centerX - width / 2,
        ),
      ),
    );
    const top = Math.round(
      metaPos.placement === "top"
        ? anchor.top - gap - height
        : anchor.bottom + gap,
    );

    setMetaPos((current) => ({ ...current, left, top }));
    setMetaReady(true);
  }, [metaOpen, metaPos.placement, metaRevision]);

  useEffect(() => {
    if (!metaOpen) return;
    const close = () => setMetaOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [metaOpen]);

  // 编辑态：标题变输入框，右侧显示提交/取消
  if (editing) {
    return (
      <div
        className={`group flex items-center gap-2 rounded-md px-2 py-2 ${
          isActive ? "bg-surface-active" : ""
        }`}
      >
        <input
          autoFocus
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitEdit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="min-w-0 flex-1 rounded border border-input-border bg-input-bg px-2 py-1 text-body-lg text-text outline-none focus:border-input-border-focus"
        />
        <button
          onClick={submitEdit}
          title="确认"
          className="shrink-0 rounded p-2 text-text-muted hover:text-success"
        >
          <Check className="h-4 w-4" />
        </button>
      </div>
    );
  }

  // 整行可点击：标题、Agent 标记、时间任意位置都能切换会话；
  // 行内操作按钮（停止/重命名/删除）自行 stopPropagation，避免误触发切换。
  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onMouseEnter={showMetadata}
      onMouseLeave={() => setMetaOpen(false)}
      onFocus={showMetadata}
      onBlur={() => setMetaOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`group cursor-pointer select-none rounded-md px-2 py-1.5 transition-colors ${
        isActive
          ? "ui-active bg-surface-active text-text"
          : "text-text-secondary hover:bg-surface-hover hover:text-text"
      }`}
    >
      {/* 单行：状态点 + 标题 + 右侧悬浮信息 / 操作 */}
      <div className="flex items-center gap-2">
        {isStreaming && <StatusDot status="streaming" />}
        <span className="min-w-0 flex-1 truncate text-body-lg">{session.title}</span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {isStreaming ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAbort();
              }}
              title="停止运行"
              className="shrink-0 rounded p-1 text-text-muted hover:text-error"
            >
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startEdit();
                }}
                title="重命名"
                className="rounded p-1 text-text-muted hover:bg-surface-active hover:text-text"
              >
                <PenLine className="h-4 w-4" />
              </button>
              <ConfirmDeleteButton onConfirm={onDelete} iconSize={16} title="删除会话" />
            </div>
          )}
        </div>
      </div>

      {metaOpen &&
        createPortal(
          <div
            ref={popupRef}
            style={{
              left: metaPos.left,
              top: metaPos.top,
              background: "var(--c-glass-strong-bg)",
              backdropFilter: "none",
              WebkitBackdropFilter: "none",
              visibility: metaReady ? "visible" : "hidden",
            }}
            className="ui-ring pointer-events-none fixed z-[100] flex w-max items-center justify-center gap-2 rounded-lg px-2.5 py-1.5 text-text shadow-[var(--c-shadow-sm)]"
          >
            <span
              className={`absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-border bg-[var(--c-glass-strong-bg)] ${
                metaPos.placement === "top"
                  ? "-bottom-[5px] border-b border-r"
                  : "-top-[5px] border-l border-t"
              }`}
            />
            <AgentPill
              agents={agents}
              agentId={session.agentId}
              iconSize={10}
              maxWidth="max-w-20"
            />
            <span className="shrink-0 font-mono text-caption text-text-muted">
              {timeAgo(session.updatedAt)}
            </span>
          </div>,
          document.body,
        )}
    </div>
  );
}
