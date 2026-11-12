/**
 * 中间区域标签栏：对话 + 已打开文件 + 终端
 *
 * activeTabId 为 null 时显示对话；非 null 时可以是文件标签或终端标签的 id。
 * 终端由 stores/terminal.ts 管理，关闭时直接销毁对应 PTY。
 *
 * 标签管理按浏览器习惯：
 * - 右键：关闭 / 关闭其他 / 关闭左侧 / 关闭右侧 / 全部关闭
 * - 中键：直接关闭当前标签
 */

import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  SquareTerminal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useFileViewerStore } from "../../stores/fileViewer";
import { useTerminalStore } from "../../stores/terminal";
import { FileTypeIcon } from "../ui/FileTypeIcon";
import { MENU_WIDTH, MenuItem, MenuPanel, MenuSeparator } from "../ui/Menu";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { clampMenuPosition } from "../../lib/popup";
import { confirmDialog } from "../../stores/confirm";

/** 右键菜单高度：3 项 + 2 条分隔线，留一点余量用于视口收拢 */
const TAB_MENU_HEIGHT = 224;

export function CenterTabs() {
  const tabs = useFileViewerStore((s) => s.tabs);
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const activateTab = useFileViewerStore((s) => s.activateTab);
  const closeFileTabs = useFileViewerStore((s) => s.closeTabs);
  const terminals = useTerminalStore((s) => s.terminals);
  const closeTerminals = useTerminalStore((s) => s.closeMany);

  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissableLayer(Boolean(menu), () => setMenu(null), [menuRef]);

  if (tabs.length === 0 && terminals.length === 0) return null;

  /** 标签栏的展示顺序：文件在前、终端在后；关闭左侧 / 右侧按这个顺序计算 */
  const allTabs = [
    ...tabs.map((tab) => ({ id: tab.id, kind: "file" as const })),
    ...terminals.map((tab) => ({ id: tab.id, kind: "terminal" as const })),
  ];

  /**
   * 批量关闭并挑一个后继标签。
   *
   * 活动标签被关掉时，优先选它右侧最近的一个，其次左侧 —— 与浏览器一致；
   * forcedActive 用于「关闭其他」：保留下来的标签应当直接成为活动标签。
   */
  const closeIds = async (ids: Set<string>, forcedActive?: string | null) => {
    if (ids.size === 0) return;
    const fileIds = tabs.filter((tab) => ids.has(tab.id)).map((tab) => tab.id);
    const terminalIds = terminals
      .filter((tab) => ids.has(tab.id))
      .map((tab) => tab.id);
    if (fileIds.length === 0 && terminalIds.length === 0) return;

    // 终端由 PTY 承载，关闭标签等于终止正在运行的命令：必须二次确认
    if (terminalIds.length > 0) {
      const ok = await confirmDialog({
        title:
          terminalIds.length === 1
            ? "关闭这个终端？"
            : `关闭这 ${terminalIds.length} 个终端？`,
        message: "正在运行的命令会被终止，未保存的交互无法恢复。",
        confirmLabel: "关闭终端",
        tone: "danger",
      });
      if (!ok) return;
    }

    let nextActive = activeTabId;
    if (activeTabId && ids.has(activeTabId)) {
      const index = allTabs.findIndex((tab) => tab.id === activeTabId);
      const after = allTabs
        .slice(index + 1)
        .find((tab) => !ids.has(tab.id));
      const before = [...allTabs.slice(0, index)]
        .reverse()
        .find((tab) => !ids.has(tab.id));
      nextActive = after?.id ?? before?.id ?? null;
    }

    closeFileTabs(fileIds);
    closeTerminals(terminalIds);

    if (forcedActive !== undefined) activateTab(forcedActive);
    else if (nextActive !== activeTabId) activateTab(nextActive);
  };

  const closeOne = (id: string) => void closeIds(new Set([id]));

  const openMenu = (event: ReactMouseEvent, id: string) => {
    event.preventDefault();
    setMenu({
      id,
      ...clampMenuPosition(event.clientX, event.clientY, {
        width: MENU_WIDTH,
        height: TAB_MENU_HEIGHT,
      }),
    });
  };

  const tabHandlers = (id: string) => ({
    onContextMenu: (event: ReactMouseEvent) => openMenu(event, id),
    // 中键按下时阻止 Chromium 的自动滚动，抬起后再关闭标签
    onMouseDown: (event: ReactMouseEvent) => {
      if (event.button === 1) event.preventDefault();
    },
    onAuxClick: (event: ReactMouseEvent) => {
      if (event.button === 1) {
        event.preventDefault();
        closeOne(id);
      }
    },
  });

  const chipClass = (active: boolean) =>
    `flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2.5 ui-type-note transition-colors ${
      active
        ? "bg-surface-active text-text"
        : "text-text-secondary hover:bg-surface-hover hover:text-text"
    }`;

  const tabClass = (active: boolean) =>
    `group flex h-7 max-w-52 min-w-0 shrink-0 items-center rounded-sm transition-colors ${
      active
        ? "bg-surface-active text-text"
        : "text-text-secondary hover:bg-surface-hover hover:text-text"
    }`;

  const closeButtonClass =
    "mr-1 rounded-sm p-0.5 text-text-muted opacity-0 transition-opacity hover:bg-surface-hover hover:text-text group-hover:opacity-100 group-focus-within:opacity-100";

  const menuIndex = menu
    ? allTabs.findIndex((tab) => tab.id === menu.id)
    : -1;

  return (
    <div className="ui-glass relative z-20 flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
      <button
        type="button"
        onClick={() => activateTab(null)}
        className={chipClass(activeTabId === null)}
      >
        <MessageSquare className="h-3.5 w-3.5" />
        对话
      </button>

      <div className="mx-1 h-4 w-px shrink-0 bg-border" />

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = activeTabId === tab.id;
          return (
            <div
              key={tab.id}
              className={tabClass(active)}
              {...tabHandlers(tab.id)}
            >
              <button
                type="button"
                onClick={() => activateTab(tab.id)}
                title={tab.relativePath}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
              >
                <FileTypeIcon name={tab.name} size={14} />
                <span className="truncate ui-type-note">{tab.name}</span>
              </button>
              <button
                type="button"
                onClick={() => closeOne(tab.id)}
                title={`关闭 ${tab.name}`}
                aria-label={`关闭 ${tab.name}`}
                className={closeButtonClass}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}

        {terminals.map((tab) => {
          const active = activeTabId === tab.id;
          return (
            <div
              key={tab.id}
              className={tabClass(active)}
              {...tabHandlers(tab.id)}
            >
              <button
                type="button"
                onClick={() => activateTab(tab.id)}
                title={`${tab.name} · ${tab.cwd}`}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
              >
                <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate ui-type-note">{tab.name}</span>
              </button>
              <button
                type="button"
                onClick={() => closeOne(tab.id)}
                title={`关闭 ${tab.name}`}
                aria-label={`关闭 ${tab.name}`}
                className={closeButtonClass}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {menu && menuIndex >= 0 && (
        <MenuPanel x={menu.x} y={menu.y} menuRef={menuRef}>
          <MenuItem
            icon={X}
            label="关闭"
            onClick={() => {
              closeOne(menu.id);
              setMenu(null);
            }}
          />
          <MenuItem
            icon={XCircle}
            label="关闭其他"
            disabled={allTabs.length <= 1}
            onClick={() => {
              const others = allTabs
                .filter((tab) => tab.id !== menu.id)
                .map((tab) => tab.id);
              void closeIds(new Set(others), menu.id);
              setMenu(null);
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={ChevronLeft}
            label="关闭左侧"
            disabled={menuIndex === 0}
            onClick={() => {
              void closeIds(
                new Set(allTabs.slice(0, menuIndex).map((tab) => tab.id)),
              );
              setMenu(null);
            }}
          />
          <MenuItem
            icon={ChevronRight}
            label="关闭右侧"
            disabled={menuIndex === allTabs.length - 1}
            onClick={() => {
              void closeIds(
                new Set(allTabs.slice(menuIndex + 1).map((tab) => tab.id)),
              );
              setMenu(null);
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={Trash2}
            label="全部关闭"
            danger
            onClick={() => {
              void closeIds(new Set(allTabs.map((tab) => tab.id)));
              setMenu(null);
            }}
          />
        </MenuPanel>
      )}
    </div>
  );
}
