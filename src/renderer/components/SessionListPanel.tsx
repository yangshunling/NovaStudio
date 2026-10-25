/**
 * 会话页左栏 — 扁平会话列表
 *
 * 设计取舍：
 * - 不再展示「项目 → 会话」树。项目是会话的可选上下文（工作目录），
 *   在输入框旁按需绑定，而不是浏览会话的前置层级。
 * - 顶部「+」直接进入新会话态；首条消息时才真正落库，避免空会话堆积。
 * - 每一行展示标题与上下文（绑定的项目或使用的 Agent）+ 更新时间；
 *   重命名 / 删除收进右键菜单，运行中单独显示停止按钮。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Folder,
  MessageSquare,
  MessageSquarePlus,
  PenLine,
  Square,
  Trash2,
} from "lucide-react";
import { useChatStore } from "../stores/chat";
import { getAgentName, timeAgo } from "../lib/utils";
import type { AgentInfo } from "@shared/contracts/agent";
import type { Project, Session } from "@shared/types";
import { StatusDot } from "./ui/StatusDot";

/** 右键菜单尺寸：用于贴近视口边缘时收拢位置 */
const MENU_WIDTH = 176;
const MENU_HEIGHT = 88;

export function SessionListPanel() {
  const sessions = useChatStore((s) => s.sessions);
  const projects = useChatStore((s) => s.projects);
  const agents = useChatStore((s) => s.agents);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const streamingBySession = useChatStore((s) => s.streamingBySession);
  // 逐项订阅 action：避免无 selector 的 useChatStore() 让整个面板
  // 在每次流式 token 到达时重渲染
  const selectSession = useChatStore((s) => s.selectSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const newSession = useChatStore((s) => s.newSession);
  const abort = useChatStore((s) => s.abort);

  /** 会话 → 绑定的项目；解绑后为 undefined */
  const projectById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of projects) map.set(project.id, project);
    return map;
  }, [projects]);

  return (
    <aside className="flex w-[var(--c-layout-session-list)] shrink-0 flex-col border-r border-border bg-[var(--c-panel-bg)]">
      {/* 头部：会话 + 新建会话（高度与右侧会话区顶栏一致） */}
      <div className="flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
            <MessageSquare className="h-3.5 w-3.5" />
          </span>
          <span className="truncate text-body-lg font-semibold text-text">会话</span>
          {sessions.length > 0 && (
            <span className="rounded-full bg-surface-hover px-2 py-0.5 font-mono text-caption leading-none text-text-muted">
              {sessions.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={newSession}
          title="新建会话"
          aria-label="新建会话"
          className="ui-btn-round ui-icon-action flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors active:scale-95"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </button>
      </div>

      {/* 扁平会话列表：按更新时间倒序（主进程已排序） */}
      <div className="ui-scroll-hidden min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-3">
        {sessions.length === 0 ? (
          <div className="mx-auto mt-4 flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border-strong/70 bg-surface-2/30 px-5 py-10 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent shadow-[var(--c-shadow-sm)]">
              <MessageSquarePlus className="h-6 w-6" />
            </span>
            <div className="space-y-1">
              <p className="text-body-lg font-semibold text-text">还没有会话</p>
              <p className="text-meta leading-relaxed text-text-muted">
                直接在右侧输入消息即可开始。需要读写本地文件时，
                在输入框旁绑定一个项目目录。
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                project={
                  session.projectId
                    ? projectById.get(session.projectId)
                    : undefined
                }
                isActive={session.id === currentSessionId}
                isStreaming={!!streamingBySession[session.id]}
                agents={agents}
                onOpen={() => selectSession(session.id)}
                onDelete={() => deleteSession(session.id)}
                onAbort={() => abort(session.id)}
                onRename={(title) => renameSession(session.id, title)}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

// ============================================================================
// 会话行：标题 + 上下文（项目 / Agent）+ 时间
// ============================================================================

function SessionRow({
  session,
  project,
  isActive,
  isStreaming,
  agents,
  onOpen,
  onDelete,
  onAbort,
  onRename,
}: {
  session: Session;
  project?: Project;
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
  const inputRef = useRef<HTMLInputElement>(null);
  /** 右键菜单坐标（视口坐标）；null 表示关闭 */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const startEdit = () => {
    setMenu(null);
    setEditTitle(session.title);
    setEditing(true);
  };

  /** 打开右键菜单；坐标收拢在视口内，避免贴边被裁掉 */
  const openMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - 8)),
    });
  };

  const requestDelete = () => {
    setMenu(null);
    const confirmed = window.confirm(
      `删除会话「${session.title}」？\n\n此操作不可恢复。`,
    );
    if (confirmed) onDelete();
  };

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
  const submitEdit = () => {
    const t = editTitle.trim();
    if (t && t !== session.title) onRename(t);
    setEditing(false);
  };

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (editing) {
    return (
      <div
        className={`group flex items-center gap-2 rounded-lg px-2.5 py-1.5 ${
          isActive ? "bg-surface-active" : ""
        }`}
      >
        <input
          ref={inputRef}
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

  // 项目绑定后副标题展示项目名，否则展示实际执行该会话的 Agent。
  // 两者都比「无信息的空白行」更有用，且不额外占用高度。
  const contextLabel = project ? project.name : getAgentName(agents, session.agentId);
  const contextTitle = project ? project.cwd : "未绑定项目";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onContextMenu={openMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`relative cursor-pointer select-none rounded-lg px-2.5 py-1.5 transition-colors ${
        isActive
          ? "bg-surface-active text-text"
          : "text-text-secondary hover:bg-surface-hover/70 hover:text-text"
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-[5px] flex h-2.5 w-2.5 shrink-0 items-center justify-center">
          {isStreaming ? (
            <StatusDot status="streaming" />
          ) : (
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${
                isActive ? "bg-accent" : "bg-border-strong/70"
              }`}
            />
          )}
        </span>

        <div className={`min-w-0 flex-1 ${isStreaming ? "pr-7" : ""}`}>
          <div
            className={`truncate text-body leading-5 ${isActive ? "font-medium" : ""}`}
          >
            {session.title}
          </div>
          <div
            title={contextTitle}
            className="mt-0.5 flex items-center gap-1 truncate text-caption text-text-muted"
          >
            {project ? (
              <Folder className="h-3 w-3 shrink-0" />
            ) : (
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-border-strong/80"
              />
            )}
            <span className="truncate">{contextLabel}</span>
            <span className="shrink-0 opacity-50">·</span>
            <span className="shrink-0">{timeAgo(session.updatedAt)}</span>
          </div>
        </div>
      </div>

      {/* 运行中的停止按钮：属于即时操作，不放进右键菜单 */}
      {isStreaming && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAbort();
          }}
          title="停止运行"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-text-muted transition-colors hover:bg-error-bg hover:text-error"
        >
          <Square className="h-4 w-4" />
        </button>
      )}

      {/* 重命名 / 删除统一收进右键菜单，保持列表清爽 */}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: menu.y, left: menu.x, width: MENU_WIDTH }}
            className="ui-dropdown-in ui-glass-strong ui-ring fixed z-[60] space-y-0.5 rounded-xl p-1.5"
          >
            <button
              type="button"
              onClick={startEdit}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-body text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            >
              <PenLine className="h-4 w-4 shrink-0" />
              重命名
            </button>

            <div className="my-1 h-px bg-border" />

            <button
              type="button"
              onClick={requestDelete}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-body text-error transition-colors hover:bg-error-bg"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              删除会话
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
