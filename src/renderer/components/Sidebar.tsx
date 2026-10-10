/**
 * 侧边栏 — 项目 → 会话 树
 *
 * 交互：
 *   点 + → 直接弹原生文件夹选择器 → 用文件夹名当项目名创建（无需命名）
 *   项目可折叠；会话点击切换，hover 删除，运行中显示停止按钮
 *
 * 字号/间距偏大，保证最小点击区 ~36px，移动鼠标不费力。
 */

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../stores/chat";
import {
  Plus,
  Trash2,
  Check,
  ChevronRight,
  PenLine,
  Square,
  Workflow,
  Settings,
  MoreHorizontal,
  Eraser,
} from "lucide-react";
import type { Project, Session } from "@shared/types";
import type { AgentInfo } from "@shared/contracts/agent";
import logoUrl from "../assets/logo.png";
import { timeAgo } from "../lib/utils";
import { AgentPill } from "./ui/AgentPill";
import { ConfirmDeleteButton } from "./ui/ConfirmDeleteButton";
import { FolderTypeIcon } from "./ui/FolderTypeIcon";
import { StatusDot } from "./ui/StatusDot";

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
  const {
    selectSession,
    selectProject,
    newSession,
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

  return (
    <aside className="ui-sidebar relative flex h-full w-[var(--c-layout-sidebar)] flex-col border-r-0">
      {/* 头部：品牌 + 新建项目 */}
      <div className="relative flex h-[var(--c-layout-header)] items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <img
            src={logoUrl}
            alt="Nova"
            className="h-8 w-8 rounded-lg object-cover"
          />
          <span className="text-title font-semibold tracking-wide text-text">Nova</span>
        </div>
        <button
          onClick={handleNewProject}
          title="新建项目（选择文件夹）"
          className="ui-btn-round flex size-icon-btn items-center justify-center rounded-full"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* 功能分组 */}
      <div className="px-3 pt-3 pb-1">
        <span className={`px-1 ${FONT_META} font-medium tracking-wide text-text-muted`}>功能</span>
      </div>
      <div className="px-2.5 pb-2">
        <button
          onClick={() => setViewMode("automation")}
          className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2.5 text-body-lg font-medium transition-colors ${
            viewMode === "automation"
              ? "ui-active bg-surface-active text-text"
              : "text-text-secondary hover:bg-surface-hover hover:text-text"
          }`}
        >
          <Workflow className="h-4 w-4 shrink-0" />
          自动化
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
              activeSessionId={currentSessionId}
              onOpenSession={(id) => {
                selectSession(id);
                setViewMode("chat");
              }}
              onNewSession={() => {
                selectProject(project.id);
                newSession();
                setViewMode("chat");
              }}
              onDeleteSession={(id) => deleteSession(id)}
              onAbortSession={(id) => abort(id)}
              onRenameSession={(id, title) => renameSession(id, title)}
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
  activeSessionId,
  onOpenSession,
  onNewSession,
  onDeleteSession,
  onAbortSession,
  onRenameSession,
  onClearSessions,
  onDeleteProject,
}: {
  project: Project;
  sessions: Session[];
  streamingBySession: Record<string, boolean>;
  agents: AgentInfo[];
  isExpanded: boolean;
  onToggle: () => void;
  activeSessionId: string | null;
  onOpenSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onAbortSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onClearSessions: () => void;
  onDeleteProject: () => void;
}) {
  return (
    <div>
      {/* 项目头 */}
      <div className="group/proj flex items-center gap-1 rounded-lg px-1.5 hover:bg-surface-hover">
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-start gap-1.5 py-2.5 text-left"
        >
          <ChevronRight
            className={`mt-0.5 h-4 w-4 shrink-0 text-text-muted transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
          <FolderTypeIcon open={isExpanded} className="mt-0.5" />
          {/* 项目名与路径分两行：路径独占一行、过长省略，不再与项目名抢宽度 */}
          <span className="min-w-0 flex-1">
            <span className={`block truncate ${FONT_BODY} font-medium`}>
              {project.name}
            </span>
            {project.cwd && (
              <span
                className="mt-0.5 block truncate font-mono text-caption text-text-muted"
                title={project.cwd}
              >
                {project.cwd}
              </span>
            )}
          </span>
        </button>
        {/* 项目操作：⋯ 菜单（清空会话 / 删除项目） */}
        <div className="flex shrink-0 items-center gap-0.5">
          <ProjectMenu
            sessionCount={sessions.length}
            onClearSessions={onClearSessions}
            onDeleteProject={onDeleteProject}
          />
        </div>
      </div>

      {/* 会话列表 */}
      {isExpanded && (
        <div className="ml-3 space-y-2 border-l border-border pl-2 pt-2">
          {/* 新建会话行：放在列表最前面，会话再多也不用滑到底部 */}
          <button
            onClick={onNewSession}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-2.5 text-body text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <Plus className="h-4 w-4" />
            新会话
          </button>
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
// 项目操作菜单：清空所有会话 / 删除项目
// ============================================================================

/** 面板宽度：定位要按它右对齐到按钮，单独定义避免与 class 里的宽度写重 */
const MENU_WIDTH = 192;

/**
 * 「⋯」菜单。面板用 fixed 定位挂在按钮下方 —— 侧栏会话树本身是滚动容器，
 * 绝对定位的下拉会被 overflow 裁掉（最后一个项目尤其明显）。
 */
function ProjectMenu({
  sessionCount,
  onClearSessions,
  onDeleteProject,
}: {
  sessionCount: number;
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
    setPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - MENU_WIDTH) });
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
              <span className="ml-auto font-mono text-caption text-text-muted">{sessionCount}</span>
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
// 会话行：双行布局 — 第一行标题+操作，第二行 Agent 标记+时间
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

  const startEdit = () => {
    setEditTitle(session.title);
    setEditing(true);
  };
  const submitEdit = () => {
    const t = editTitle.trim();
    if (t && t !== session.title) onRename(t);
    setEditing(false);
  };

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
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`group cursor-pointer select-none rounded-md px-2 py-2 transition-colors ${
        isActive
          ? "ui-active bg-surface-active text-text"
          : "text-text-secondary hover:bg-surface-hover hover:text-text"
      }`}
    >
      {/* 第一行：标题 + 操作按钮（流式时保留脉动圆点，选中态由左侧竖杠表示） */}
      <div className="flex items-center gap-2">
        {isStreaming && <StatusDot status="streaming" />}
        <span className="min-w-0 flex-1 truncate text-body-lg">{session.title}</span>

        {isStreaming ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAbort();
            }}
            title="停止运行"
            className="shrink-0 rounded p-1.5 text-text-muted hover:text-error"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={(e) => {
                e.stopPropagation();
                startEdit();
              }}
              title="重命名"
              className="rounded p-1.5 text-text-muted hover:bg-surface-active hover:text-text"
            >
              <PenLine className="h-4 w-4" />
            </button>
            {/* 删除会话：二次确认由 ConfirmDeleteButton 内部管理（内部已 stopPropagation） */}
            <ConfirmDeleteButton onConfirm={onDelete} iconSize={16} title="删除会话" />
          </div>
        )}
      </div>

      {/* 第二行：Agent 标记 + 时间（与标题对齐） */}
      <div className="mt-1 flex items-center gap-2 text-caption">
        <AgentPill agents={agents} agentId={session.agentId} iconSize={10} />
        <span className="font-mono text-text-muted">
          {timeAgo(session.updatedAt)}
        </span>
      </div>
    </div>
  );
}
