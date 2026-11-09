/**
 * 会话页左栏 — 按时间分组的会话列表
 *
 * 设计取舍：
 * - 不再展示「项目 → 会话」树。项目是会话的可选上下文（工作目录），
 *   在输入框旁按需绑定，而不是浏览会话的前置层级。
 * - 顶部「+」直接进入新会话态；首条消息时才真正落库，避免空会话堆积。
 * - 会话按「今天 / 昨天 / 本周 / 更早」分组；每行给出标题、时间、
 *   消息数与绑定项目，让列表本身就能回答「这是哪次对话」。
 * - 重命名 / 删除收进 hover 出现的「…」菜单；
 *   运行中在时间位置显示旋转图标。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MENU_WIDTH,
  MenuItem,
  MenuPanel,
  MenuSeparator,
} from "../ui/Menu";
import { INLINE_INPUT_CLASS } from "../ui/Field";
import {
  Check,
  MessageSquarePlus,
  MoreHorizontal,
  PenLine,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useChatStore } from "../../stores/chat";
import { useFileViewerStore } from "../../stores/fileViewer";
import { useTerminalStore } from "../../stores/terminal";
import { confirmDialog } from "../../stores/confirm";
import { EmptyState } from "../ui/EmptyState";
import { ListPane } from "../ui/ListPane";
import { Spinner } from "../ui/Spinner";
import type { Session } from "@shared/types";

/** 会话操作菜单尺寸：用于贴近视口边缘时收拢位置 */
const MENU_HEIGHT = 124;
const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 本周开始 = 本周一 0 点 */
function startOfWeek(ts: number): number {
  const today = startOfDay(ts);
  const weekday = (new Date(today).getDay() + 6) % 7;
  return today - weekday * DAY;
}

/**
 * 行内时间。
 *
 * 分组已经写明「今天 / 昨天 / 本周」，行内再重复一遍没有信息量，
 * 因此这两组统一只显示 HH:mm；「更早」才需要完整日期。
 */
function sessionTimeLabel(ts: number, groupId: string): string {
  const date = new Date(ts);
  if (groupId === "today" || groupId === "yesterday") {
    return `${String(date.getHours()).padStart(2, "0")}:${String(
      date.getMinutes(),
    ).padStart(2, "0")}`;
  }
  return shortDate(ts);
}

/** 组外时间：周三 / 11月3日 / 2025年11月3日 */
function shortDate(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  if (startOfDay(ts) >= startOfWeek(now)) {
    return `周${"日一二三四五六"[date.getDay()]}`;
  }
  const prefix =
    date.getFullYear() === new Date(now).getFullYear()
      ? ""
      : `${date.getFullYear()}年`;
  return `${prefix}${date.getMonth() + 1}月${date.getDate()}日`;
}

interface SessionGroup {
  id: string;
  label: string;
  items: Session[];
}

/** 按最近更新时间分组，组内新的在前 */
function groupSessions(sessions: Session[], now = Date.now()): SessionGroup[] {
  const today = startOfDay(now);
  const weekStart = startOfWeek(now);
  const groups: SessionGroup[] = [
    { id: "today", label: "今天", items: [] },
    { id: "yesterday", label: "昨天", items: [] },
    { id: "week", label: "本周", items: [] },
    { id: "earlier", label: "更早", items: [] },
  ];

  for (const session of [...sessions].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  )) {
    const day = startOfDay(session.updatedAt);
    const bucket =
      day >= today
        ? groups[0]
        : day >= today - DAY
          ? groups[1]
          : day >= weekStart
            ? groups[2]
            : groups[3];
    bucket.items.push(session);
  }

  return groups.filter((group) => group.items.length > 0);
}

export function SessionListPanel() {
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const streamingBySession = useChatStore((s) => s.streamingBySession);
  const projects = useChatStore((s) => s.projects);
  // 逐项订阅 action：避免无 selector 的 useChatStore() 让整个面板
  // 在每次流式 token 到达时重渲染
  const selectSession = useChatStore((s) => s.selectSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const newSession = useChatStore((s) => s.newSession);
  const openTerminal = useTerminalStore((s) => s.open);
  const terminals = useTerminalStore((s) => s.terminals);
  const activateCenterTab = useFileViewerStore((s) => s.activateTab);

  const groups = useMemo(() => groupSessions(sessions), [sessions]);

  /** 在会话工作目录里新建终端，并作为中心区域的新标签打开 */
  const openSessionTerminal = (session: Session) => {
    const usedNames = new Set(terminals.map((tab) => tab.name));
    let index = terminals.length + 1;
    while (usedNames.has(`终端 ${index}`)) index += 1;

    const id = openTerminal({
      workspaceId: session.projectId,
      cwd: session.cwd,
      name: `终端 ${index}`,
      forceNew: true,
    });
    activateCenterTab(id);
  };

  return (
    <ListPane
      title="会话"
      count={sessions.length}
      action={
        <button
          type="button"
          onClick={newSession}
          title="新建会话"
          aria-label="新建会话"
          className="ui-btn-round ui-icon-action flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors active:scale-95"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </button>
      }
    >
      {sessions.length === 0 ? (
        <EmptyState
          size="compact"
          icon={<MessageSquarePlus />}
          title="还没有会话"
          description="直接在右侧输入消息即可开始。需要读写本地文件时，在输入框旁选择一个工作区。"
        />
      ) : (
        groups.map((group) => (
          <div key={group.id} className="pb-1">
            <div className="flex items-center gap-2 px-2 pb-1 pt-2">
              <span className="text-caption font-semibold text-text-muted">
                {group.label}
              </span>
              <span className="text-caption tabular-nums text-text-muted/60">
                {group.items.length}
              </span>
            </div>
            <div className="space-y-0.5">
              {group.items.map((session) => (
                <SessionRow
                  key={session.id}
                  group={group.id}
                  session={session}
                  projectName={
                    projects.find((project) => project.id === session.projectId)
                      ?.name
                  }
                  isActive={session.id === currentSessionId}
                  isStreaming={!!streamingBySession[session.id]}
                  onOpen={() => selectSession(session.id)}
                  onDelete={() => deleteSession(session.id)}
                  onRename={(title) => renameSession(session.id, title)}
                  onNewTerminal={() => openSessionTerminal(session)}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </ListPane>
  );
}

// ============================================================================
// 会话行：标题 + 时间 + 项目 / 消息数
// ============================================================================

function SessionRow({
  group,
  session,
  projectName,
  isActive,
  isStreaming,
  onOpen,
  onDelete,
  onRename,
  onNewTerminal,
}: {
  /** 所属分组：决定行内时间显示精度（组内不再重复「昨天」这类词） */
  group: string;
  session: Session;
  projectName?: string;
  isActive: boolean;
  isStreaming: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  /** 在会话工作目录中打开终端 */
  onNewTerminal: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  /** 菜单坐标（视口坐标）；null 表示关闭 */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const startEdit = () => {
    setMenu(null);
    setEditTitle(session.title);
    setEditing(true);
  };

  /** hover 出的「…」按按钮位置展开菜单 */
  const openMenuAtButton = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({
      x: Math.max(
        8,
        Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8),
      ),
      y: Math.max(
        8,
        Math.min(rect.bottom + 4, window.innerHeight - MENU_HEIGHT - 8),
      ),
    });
  };

  const requestDelete = async () => {
    setMenu(null);
    const confirmed = await confirmDialog({
      title: `删除会话「${session.title}」？`,
      message: "此操作不可恢复。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (confirmed) onDelete();
  };

  // 菜单：外部点击 / Esc / 滚动 / 窗口缩放时关闭
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
        className={`group flex items-center gap-2 rounded-lg px-2.5 py-2.5 ${
          isActive ? "bg-accent-soft/60" : ""
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
          className={`${INLINE_INPUT_CLASS} text-body`}
        />
        <button
          onClick={submitEdit}
          title="确认"
          aria-label="确认重命名"
          className="shrink-0 rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-success"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  const meta: string[] = [];
  if (!isStreaming) {
    if (projectName) meta.push(projectName);
    if (session.messageCount) meta.push(`${session.messageCount} 条`);
  }

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
      className={`ui-cv-row group relative cursor-pointer select-none rounded-lg px-2.5 py-2 transition-colors ${
        isActive
          ? "bg-accent-soft/60 text-text"
          : "text-text-secondary hover:bg-surface-hover/70 hover:text-text"
      }`}
    >
      {/* 选中态：左侧细竖条，比整块变色更克制 */}
      {isActive && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-accent"
        />
      )}

      <div className="flex items-center gap-2">
        <div
          className={`min-w-0 flex-1 truncate text-body-lg leading-5 ${
            isActive ? "font-medium" : ""
          }`}
        >
          {session.title}
        </div>
        <span className="flex shrink-0 items-center text-caption tabular-nums text-text-muted transition-opacity group-hover:opacity-0">
          {isStreaming ? (
            <Spinner label="正在执行" className="h-4 w-4 text-accent" />
          ) : (
            sessionTimeLabel(session.updatedAt, group)
          )}
        </span>
      </div>

      {(meta.length > 0 || isStreaming) && (
        <div className="mt-0.5 flex min-w-0 items-center gap-1 text-caption text-text-muted">
          {isStreaming && <span className="shrink-0 text-accent">执行中</span>}
          {meta.map((item, index) => (
            <span key={item} className="flex min-w-0 items-center gap-1">
              {(index > 0 || isStreaming) && (
                <span className="shrink-0 opacity-50">·</span>
              )}
              <span className="truncate">{item}</span>
            </span>
          ))}
        </div>
      )}

      {/* hover 时在时间位置出现「…」，点开重命名 / 删除菜单 */}
      <button
        type="button"
        onClick={openMenuAtButton}
        title="会话操作"
        aria-label="会话操作"
        className={`absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-text-muted transition-all hover:bg-surface-hover hover:text-text ${
          menu
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
        }`}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>

      {/* 重命名 / 删除统一收进「…」菜单，保持列表清爽 */}
      {menu && (
        <MenuPanel x={menu.x} y={menu.y} menuRef={menuRef}>
          <MenuItem icon={PenLine} label="重命名" onClick={startEdit} />
          <MenuItem
            icon={SquareTerminal}
            label="新建终端"
            onClick={() => {
              setMenu(null);
              onNewTerminal();
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={Trash2}
            label="删除会话"
            danger
            onClick={requestDelete}
          />
        </MenuPanel>
      )}
    </div>
  );
}
