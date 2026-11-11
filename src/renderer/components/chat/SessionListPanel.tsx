/**
 * 会话页左栏 — 按时间分组的会话列表
 *
 * 设计取舍：
 * - 不再展示「项目 → 会话」树。项目是会话的可选上下文（工作目录），
 *   在输入框旁按需绑定，而不是浏览会话的前置层级。
 * - 顶部「+」直接进入新会话态；首条消息时才真正落库，避免空会话堆积。
 * - 置顶会话固定在最上方的「置顶」组；其余按「今天 / 昨天 / 本周 / 更早」
 *   分组。每个分组标题可点击折叠，状态记在 localStorage。
 * - 每行给出标题、时间、消息数与绑定项目，让列表本身就能回答「这是哪次对话」。
 * - 置顶 / 重命名 / 新建终端 / 删除收进 hover 出现的「…」菜单；
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
  ChevronRight,
  MessageSquarePlus,
  MoreHorizontal,
  PenLine,
  Pin,
  PinOff,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { parseJsonSafe } from "@shared/json";
import { useChatStore } from "../../stores/chat";
import { useFileViewerStore } from "../../stores/fileViewer";
import { useTerminalStore } from "../../stores/terminal";
import { confirmDialog } from "../../stores/confirm";
import {
  requestComposerFocus,
  requestWorkspaceMenu,
} from "../../lib/chat-events";
import { clampMenuPosition } from "../../lib/popup";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { ListPane } from "../ui/ListPane";
import { Spinner } from "../ui/Spinner";
import type { Session } from "@shared/types";
import {
  DAY_MS,
  formatHm,
  startOfDay,
  startOfWeek,
  WEEKDAY_LABELS,
} from "@shared/time";

/** 会话操作菜单尺寸：用于贴近视口边缘时收拢位置（置顶 / 重命名 / 终端 / 删除） */
const MENU_HEIGHT = 160;

/** 分组折叠状态：纯界面偏好，存 localStorage；不可用时退化为内存态 */
const COLLAPSED_KEY = "nova-session-groups-collapsed";

function readCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed = parseJsonSafe<unknown>(raw, []);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((item): item is string => typeof item === "string"),
    );
  } catch {
    return new Set();
  }
}

/**
 * 行内时间。
 *
 * 分组已经写明「今天 / 昨天 / 本周」，行内再重复一遍没有信息量，
 * 因此这两组统一只显示 HH:mm；「更早」才需要完整日期。
 */
function sessionTimeLabel(ts: number, groupId: string): string {
  if (groupId === "today" || groupId === "yesterday") return formatHm(ts);
  // 置顶组横跨所有时间：当天更新的仍显示时刻，其余显示日期
  if (groupId === "pinned" && startOfDay(ts) >= startOfDay(Date.now())) {
    return formatHm(ts);
  }
  return shortDate(ts);
}

/** 组外时间：周三 / 11月3日 / 2025年11月3日 */
function shortDate(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  if (startOfDay(ts) >= startOfWeek(now)) {
    return `周${WEEKDAY_LABELS[date.getDay()]}`;
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

/**
 * 置顶组固定在最上方（按置顶时间倒序），其余按最近更新时间分组。
 * 置顶会话不再出现在时间组里，避免同一行同时出现在两个分组。
 */
function groupSessions(sessions: Session[], now = Date.now()): SessionGroup[] {
  const today = startOfDay(now);
  const weekStart = startOfWeek(now);

  const pinned = sessions
    .filter((session) => session.pinnedAt)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  const groups: SessionGroup[] = pinned.length
    ? [{ id: "pinned", label: "置顶", items: pinned }]
    : [];

  const timeGroups: SessionGroup[] = [
    { id: "today", label: "今天", items: [] },
    { id: "yesterday", label: "昨天", items: [] },
    { id: "week", label: "本周", items: [] },
    { id: "earlier", label: "更早", items: [] },
  ];

  for (const session of sessions
    .filter((item) => !item.pinnedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)) {
    const day = startOfDay(session.updatedAt);
    const bucket =
      day >= today
        ? timeGroups[0]
        : day >= today - DAY_MS
          ? timeGroups[1]
          : day >= weekStart
            ? timeGroups[2]
            : timeGroups[3];
    bucket.items.push(session);
  }

  return [
    ...groups,
    ...timeGroups.filter((group) => group.items.length > 0),
  ];
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
  const pinSession = useChatStore((s) => s.pinSession);
  const newSession = useChatStore((s) => s.newSession);
  const openTerminal = useTerminalStore((s) => s.open);
  const terminals = useTerminalStore((s) => s.terminals);
  const activateCenterTab = useFileViewerStore((s) => s.activateTab);

  /**
   * 新建会话 = 先选工作区，再输入。
   *
   * 输入框常驻挂载，autoFocus 只在首次挂载时生效，点击按钮本身也不会把
   * 焦点交给输入框；因此显式请求展开工作区选择器，由它接管焦点，
   * 用户选定（或按 Esc 放弃）后再交还输入框。
   * 同时切回「对话」标签：输入框被文件预览 / 终端盖住时选择器不可见。
   */
  const startNewSession = () => {
    newSession();
    activateCenterTab(null);
    requestWorkspaceMenu();
  };

  const groups = useMemo(() => groupSessions(sessions), [sessions]);

  const [collapsedGroups, setCollapsedGroups] =
    useState<Set<string>>(readCollapsedGroups);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedGroups]));
    } catch {
      // localStorage 不可用时只保留内存态
    }
  }, [collapsedGroups]);

  const toggleGroup = (id: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 置顶后会话会跳到「置顶」组：该组处于折叠态时自动展开，避免看起来像消失 */
  const togglePin = (session: Session) => {
    const pinning = !session.pinnedAt;
    if (pinning) {
      setCollapsedGroups((current) => {
        if (!current.has("pinned")) return current;
        const next = new Set(current);
        next.delete("pinned");
        return next;
      });
    }
    void pinSession(session.id, pinning);
  };

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
        <IconButton
          icon={<MessageSquarePlus className="h-4 w-4" />}
          label="新建会话"
          tone="muted"
          onClick={startNewSession}
        />
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
        groups.map((group) => {
          const collapsed = collapsedGroups.has(group.id);
          return (
            <div key={group.id} className="pb-1">
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                aria-expanded={!collapsed}
                title={collapsed ? `展开${group.label}` : `收起${group.label}`}
                className="group/header flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 pb-1 pt-2 text-left text-text-muted transition-colors hover:text-text"
              >
                <ChevronRight
                  className={`h-3 w-3 shrink-0 opacity-60 transition-transform group-hover/header:opacity-100 ${
                    collapsed ? "" : "rotate-90"
                  }`}
                />
                <span className="ui-type-sub font-semibold">{group.label}</span>
                <span className="ui-type-sub tabular-nums text-text-muted/50">
                  {group.items.length}
                </span>
              </button>
              {!collapsed && (
                <div className="space-y-0.5">
                  {group.items.map((session) => (
                    <SessionRow
                      key={session.id}
                      group={group.id}
                      session={session}
                      projectName={
                        projects.find(
                          (project) => project.id === session.projectId,
                        )?.name
                      }
                      isActive={session.id === currentSessionId}
                      isStreaming={!!streamingBySession[session.id]}
                      onOpen={() => {
                        void selectSession(session.id);
                        // 点击会话即回到「对话」标签：否则文件预览 / 终端会盖住
                        // 输入框，焦点落在一个不可见的元素上。
                        activateCenterTab(null);
                        requestComposerFocus();
                      }}
                      onDelete={() => deleteSession(session.id)}
                      onRename={(title) => renameSession(session.id, title)}
                      onTogglePin={() => togglePin(session)}
                      onNewTerminal={() => openSessionTerminal(session)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })
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
  onTogglePin,
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
  /** 置顶 / 取消置顶 */
  onTogglePin: () => void;
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
    setMenu(
      clampMenuPosition(rect.right - MENU_WIDTH, rect.bottom + 4, {
        width: MENU_WIDTH,
        height: MENU_HEIGHT,
      }),
    );
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
  useDismissableLayer(Boolean(menu), () => setMenu(null), [menuRef]);
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
          isActive ? "bg-selected" : ""
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
          className={`${INLINE_INPUT_CLASS} ui-type-body`}
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
          ? "bg-selected text-text"
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
          className={`min-w-0 flex-1 truncate ui-type-item leading-5 ${
            isActive ? "font-medium" : ""
          }`}
        >
          {session.title}
        </div>
        <span className="flex shrink-0 items-center ui-type-sub tabular-nums text-text-muted transition-opacity group-hover:opacity-0">
          {isStreaming ? (
            <Spinner label="正在执行" className="h-4 w-4 text-accent" />
          ) : (
            sessionTimeLabel(session.updatedAt, group)
          )}
        </span>
      </div>

      {(meta.length > 0 || isStreaming) && (
        <div className="mt-0.5 flex min-w-0 items-center gap-1 ui-type-sub text-text-muted">
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

      {/* 置顶 / 重命名 / 终端 / 删除统一收进「…」菜单，保持列表清爽 */}
      {menu && (
        <MenuPanel x={menu.x} y={menu.y} menuRef={menuRef}>
          <MenuItem
            icon={session.pinnedAt ? PinOff : Pin}
            label={session.pinnedAt ? "取消置顶" : "置顶"}
            onClick={() => {
              setMenu(null);
              onTogglePin();
            }}
          />
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
