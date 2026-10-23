/**
 * 会话页左栏 — 项目 → 会话 树
 *
 * 从全局侧栏迁移而来：项目不再占用导航栏，只在会话页内展示。
 * 交互：
 *   右上角「+」→ 原生文件夹选择器 → 用文件夹名当项目名创建
 *   项目可折叠；会话点击切换，hover 显示重命名 / 删除，运行中显示停止按钮
 *   项目右键 → 新建终端 / 清空所有会话 / 删除项目
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronRight,
  Eraser,
  Folder,
  FolderPlus,
  MessageSquare,
  PenLine,
  Square,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useChatStore } from "../stores/chat";
import { useFileViewerStore } from "../stores/fileViewer";
import { dirName, timeAgo } from "../lib/utils";
import { toast } from "../stores/toast";
import type { AgentInfo } from "@shared/contracts/agent";
import type { Project, Session } from "@shared/types";
import { AgentPill } from "./ui/AgentPill";
import { ConfirmDeleteButton } from "./ui/ConfirmDeleteButton";
import { FolderTypeIcon } from "./ui/FolderTypeIcon";
import { StatusDot } from "./ui/StatusDot";

/** 右键菜单尺寸：用于贴近视口边缘时收拢位置 */
const MENU_WIDTH = 192;
const MENU_HEIGHT = 160;

/** 项目副标题只保留末尾两级目录，避免长路径把行撑乱 */
function shortPath(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…/${parts.slice(-2).join("/")}`;
}

export function SessionListPanel() {
  const projects = useChatStore((s) => s.projects);
  const sessions = useChatStore((s) => s.sessions);
  const agents = useChatStore((s) => s.agents);
  const currentProjectId = useChatStore((s) => s.currentProjectId);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const streamingBySession = useChatStore((s) => s.streamingBySession);
  const openTerminal = useFileViewerStore((s) => s.openTerminal);
  // 逐项订阅 action：避免无 selector 的 useChatStore() 让整个面板
  // 在每次流式 token 到达时重渲染
  const selectSession = useChatStore((s) => s.selectSession);
  const selectProject = useChatStore((s) => s.selectProject);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const createProject = useChatStore((s) => s.createProject);
  const deleteProject = useChatStore((s) => s.deleteProject);
  const clearProjectSessions = useChatStore((s) => s.clearProjectSessions);
  const renameSession = useChatStore((s) => s.renameSession);
  const pickDirectory = useChatStore((s) => s.pickDirectory);
  const abort = useChatStore((s) => s.abort);

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of sessions) {
      const list = map.get(session.projectId);
      if (list) list.push(session);
      else map.set(session.projectId, [session]);
    }
    return map;
  }, [sessions]);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** 项目右键菜单：同一时间只开一个，坐标用视口坐标 */
  const [menu, setMenu] = useState<{
    project: Project;
    x: number;
    y: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const toggleExpand = (id: string) =>
    setExpanded((m) => ({ ...m, [id]: m[id] === undefined ? false : !m[id] }));

  // 右键菜单：外部点击 / Esc / 滚动 / 窗口缩放时关闭
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  /** 打开项目右键菜单；坐标收拢在视口内，避免贴边被裁掉 */
  const openProjectMenu = (project: Project, event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({
      project,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - 8)),
    });
  };

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

  /** 在指定项目目录下新建终端 */
  const handleProjectTerminal = (project: Project) => {
    setMenu(null);
    selectProject(project.id);
    openTerminal(project.cwd);
  };

  const handleClearSessions = (project: Project) => {
    setMenu(null);
    if (
      window.confirm(`清空项目「${project.name}」下的全部会话？此操作不可恢复。`)
    ) {
      clearProjectSessions(project.id);
    }
  };

  const handleDeleteProject = (project: Project) => {
    setMenu(null);
    const confirmed = window.confirm(
      [
        `删除项目「${project.name}」？`,
        "",
        "将同时删除：",
        "· 所有会话",
        "· 该项目下的工作流与运行记录",
        "· 项目目录下的 .novastudio 产物",
        "",
        "项目文件夹本身不会被删除。此操作不可恢复。",
      ].join("\n"),
    );
    if (!confirmed) return;
    void deleteProject(project.id).catch((err) =>
      toast.error(err instanceof Error ? err.message : String(err)),
    );
  };

  // 点击项目主体：选中项目 + 进入新会话态（首条消息时才真正建会话），
  // 同时确保该项目展开，让用户能看到其下会话列表。
  const handleSelectProject = (id: string) => {
    selectProject(id);
    setExpanded((m) => (m[id] === false ? { ...m, [id]: true } : m));
  };

  return (
    <aside className="flex w-[var(--c-layout-session-list)] shrink-0 flex-col border-r border-border bg-[var(--c-panel-bg)]">
      {/* 头部：项目 + 新建项目（高度与右侧会话区顶栏一致，底部分隔线贯通） */}
      <div className="flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
            <Folder className="h-3.5 w-3.5" />
          </span>
          <span className="truncate text-body-lg font-semibold text-text">项目</span>
          {projects.length > 0 && (
            <span className="rounded-full bg-surface-hover px-2 py-0.5 font-mono text-caption leading-none text-text-muted">
              {projects.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleNewProject}
          title="选择文件夹新建项目"
          aria-label="选择文件夹新建项目"
          className="ui-btn-round flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:text-accent active:scale-95"
        >
          <FolderPlus className="h-4 w-4" />
        </button>
      </div>

      {/* 项目 + 会话树 */}
      <div className="ui-scroll-hidden min-h-0 flex-1 overflow-y-auto px-3 pb-5 pt-3">
        {projects.length === 0 ? (
          <div className="mx-auto mt-4 flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border-strong/70 bg-surface-2/30 px-5 py-10 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent shadow-[var(--c-shadow-sm)]">
              <FolderPlus className="h-6 w-6" />
            </span>
            <div className="space-y-1">
              <p className="text-body-lg font-semibold text-text">还没有项目</p>
              <p className="text-meta leading-relaxed text-text-muted">
                选择一个本地文件夹作为工作目录，项目下的会话会共享它。
              </p>
            </div>
            <button
              type="button"
              onClick={handleNewProject}
              className="ui-btn-primary flex h-8 items-center gap-1.5 rounded-full px-4 text-meta font-medium active:scale-95"
            >
              <FolderPlus className="h-4 w-4" />
              选择文件夹
            </button>
          </div>
        ) : (
          <div className="space-y-2.5">
            {projects.map((project) => (
              <ProjectNode
                key={project.id}
                project={project}
                sessions={sessionsByProject.get(project.id) ?? []}
                streamingBySession={streamingBySession}
                agents={agents}
                isExpanded={expanded[project.id] ?? true}
                onToggle={() => toggleExpand(project.id)}
                onSelect={() => handleSelectProject(project.id)}
                activeSessionId={currentSessionId}
                isActiveProject={currentProjectId === project.id}
                onOpenSession={(id) => selectSession(id)}
                onDeleteSession={(id) => deleteSession(id)}
                onAbortSession={(id) => abort(id)}
                onRenameSession={(id, title) => renameSession(id, title)}
                onContextMenu={openProjectMenu}
              />
            ))}
          </div>
        )}
      </div>

      {/* 项目右键菜单（挂到 body，避免被滚动容器裁切） */}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: menu.y, left: menu.x, width: MENU_WIDTH }}
            className="ui-dropdown-in ui-glass-strong ui-ring fixed z-[60] space-y-0.5 rounded-xl p-1.5"
          >
            <button
              type="button"
              onClick={() => handleProjectTerminal(menu.project)}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-body text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            >
              <SquareTerminal className="h-4 w-4 shrink-0 text-accent" />
              新建终端
            </button>

            <div className="my-1 h-px bg-border" />

            {(() => {
              const count = sessionsByProject.get(menu.project.id)?.length ?? 0;
              return (
                <button
                  type="button"
                  disabled={count === 0}
                  onClick={() => handleClearSessions(menu.project)}
                  title={count === 0 ? "该项目下没有会话" : "一键删除该项目下的全部会话"}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-body text-text-secondary transition-colors hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
                >
                  <Eraser className="h-4 w-4 shrink-0" />
                  清空所有会话
                  {count > 0 && (
                    <span
                      title={`${count} 个会话`}
                      className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 font-mono text-caption font-semibold text-accent-foreground"
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })()}

            <button
              type="button"
              onClick={() => handleDeleteProject(menu.project)}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-body text-error transition-colors hover:bg-error-bg"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              删除项目
            </button>
          </div>,
          document.body,
        )}
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
  onContextMenu,
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
  onContextMenu: (project: Project, event: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`group/proj relative overflow-hidden rounded-xl border transition-all ${
        isActiveProject
          ? "border-accent/30 bg-accent-soft/60 shadow-[var(--c-shadow-sm)]"
          : "border-border/70 bg-surface-2/30 hover:border-border-strong hover:bg-surface-2/60"
      }`}
    >
      {/* 选中项目：左侧强调条，比整块实色背景更克制 */}
      {isActiveProject && (
        <span
          aria-hidden
          className="absolute inset-y-2.5 left-0 w-0.5 rounded-full bg-accent"
        />
      )}

      {/* 项目头：折叠箭头与选中主体分开 —— 点箭头只折叠，点主体才选中项目 */}
      <div
        onContextMenu={(event) => onContextMenu(project, event)}
        className="flex w-full items-center gap-1 px-1.5 py-1.5"
      >
        <button
          onClick={onToggle}
          title={isExpanded ? "折叠" : "展开"}
          aria-expanded={isExpanded}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
        </button>
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-0.5 text-left"
          title={project.cwd || project.name}
        >
          <span
            className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
              isActiveProject
                ? "bg-accent-soft text-accent"
                : "bg-surface-hover/80 text-text-muted group-hover/proj:text-text"
            }`}
          >
            <FolderTypeIcon open={isExpanded} size={17} />
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={`block truncate text-body-lg font-semibold ${
                isActiveProject
                  ? "text-text"
                  : "text-text-secondary group-hover/proj:text-text"
              }`}
            >
              {project.name}
            </span>
            <span className="mt-0.5 block truncate font-mono text-meta text-text-muted">
              {project.cwd ? shortPath(project.cwd) : "未设置工作目录"}
            </span>
          </span>
          <span
            title={`${sessions.length} 个会话`}
            className={`flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 font-mono text-meta tabular-nums ${
              isActiveProject
                ? "bg-accent-soft text-accent"
                : "bg-surface-hover text-text-muted"
            }`}
          >
            {sessions.length}
          </span>
        </button>
      </div>

      {/* 会话列表：竖线从文件夹图标下方延伸，保持树形层级 */}
      {isExpanded && (
        <div className="ml-[50px] border-l border-border/80 pb-2 pl-3 pr-2 pt-0.5">
          <div className="space-y-0.5">
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
          </div>
          {sessions.length === 0 && (
            <div className="flex items-center gap-1.5 py-1.5 text-meta text-text-muted">
              <MessageSquare className="h-3.5 w-3.5 opacity-60" />
              暂无会话
            </div>
          )}
        </div>
      )}
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
        className={`group flex items-center gap-2 rounded-lg py-1 pl-2.5 pr-1 ${
          isActive ? "bg-surface-active shadow-[var(--c-shadow-sm)]" : ""
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
          className="min-w-0 flex-1 rounded-md border border-input-border bg-input-bg px-2 py-1 text-body text-text outline-none focus:border-input-border-focus"
        />
        <button
          onClick={submitEdit}
          title="确认"
          className="shrink-0 rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-success"
        >
          <Check className="h-3.5 w-3.5" />
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
      className={`group relative cursor-pointer select-none rounded-lg py-2 pl-2.5 pr-1.5 transition-colors ${
        isActive
          ? "bg-surface-active text-text shadow-[var(--c-shadow-sm)]"
          : "text-text-secondary hover:bg-surface-hover hover:text-text"
      }`}
    >
      {/* 选中标识：贴左缘的一道强调色短条 */}
      {isActive && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent"
        />
      )}

      {/* 单行：状态点 + 标题 + 右侧悬浮信息 / 操作 */}
      <div className="flex items-center gap-2">
        {isStreaming && <StatusDot status="streaming" />}
        <span
          className={`min-w-0 flex-1 truncate text-body ${isActive ? "font-medium" : ""}`}
        >
          {session.title}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {isStreaming ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAbort();
              }}
              title="停止运行"
              className="shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-error-bg hover:text-error"
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
                className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-active hover:text-text"
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
