/**
 * 中间区域标签栏：对话 + 已打开文件 + 终端
 *
 * activeTabId 为 null 时显示对话；非 null 时可以是文件标签或终端标签的 id。
 * 终端由 stores/terminal.ts 管理，关闭时直接销毁对应 PTY。
 */

import { MessageSquare, SquareTerminal, X } from "lucide-react";
import { useFileViewerStore } from "../../stores/fileViewer";
import { useTerminalStore } from "../../stores/terminal";
import { FileTypeIcon } from "../ui/FileTypeIcon";

export function CenterTabs() {
  const tabs = useFileViewerStore((s) => s.tabs);
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const activateTab = useFileViewerStore((s) => s.activateTab);
  const closeTab = useFileViewerStore((s) => s.closeTab);
  const terminals = useTerminalStore((s) => s.terminals);
  const closeTerminal = useTerminalStore((s) => s.close);

  if (tabs.length === 0 && terminals.length === 0) return null;

  const chipClass = (active: boolean) =>
    `flex h-7 shrink-0 items-center gap-1.5 rounded px-2.5 text-meta transition-colors ${
      active
        ? "bg-surface-active text-text"
        : "text-text-secondary hover:bg-surface-hover hover:text-text"
    }`;

  const closeFileTab = (id: string) => {
    const wasActive = activeTabId === id;
    const remaining = tabs.filter((tab) => tab.id !== id);
    closeTab(id);
    if (wasActive) {
      activateTab(
        remaining[remaining.length - 1]?.id ??
          terminals[terminals.length - 1]?.id ??
          null,
      );
    }
  };

  const closeTerminalTab = (id: string) => {
    const wasActive = activeTabId === id;
    const remaining = terminals.filter((tab) => tab.id !== id);
    closeTerminal(id);
    if (wasActive) {
      activateTab(
        remaining[remaining.length - 1]?.id ??
          tabs[tabs.length - 1]?.id ??
          null,
      );
    }
  };

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
              className={`group flex h-7 max-w-52 min-w-0 shrink-0 items-center rounded transition-colors ${
                active
                  ? "bg-surface-active text-text"
                  : "text-text-secondary hover:bg-surface-hover hover:text-text"
              }`}
            >
              <button
                type="button"
                onClick={() => activateTab(tab.id)}
                title={tab.relativePath}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
              >
                <FileTypeIcon name={tab.name} size={14} />
                <span className="truncate text-meta">{tab.name}</span>
              </button>
              <button
                type="button"
                onClick={() => closeFileTab(tab.id)}
                title={`关闭 ${tab.name}`}
                aria-label={`关闭 ${tab.name}`}
                className="mr-1 rounded p-0.5 text-text-muted opacity-0 transition-opacity hover:bg-surface-hover hover:text-text group-hover:opacity-100 group-focus-within:opacity-100"
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
              className={`group flex h-7 max-w-52 min-w-0 shrink-0 items-center rounded transition-colors ${
                active
                  ? "bg-surface-active text-text"
                  : "text-text-secondary hover:bg-surface-hover hover:text-text"
              }`}
            >
              <button
                type="button"
                onClick={() => activateTab(tab.id)}
                title={`${tab.name} · ${tab.cwd}`}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
              >
                <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate text-meta">{tab.name}</span>
              </button>
              <button
                type="button"
                onClick={() => closeTerminalTab(tab.id)}
                title={`关闭 ${tab.name}`}
                aria-label={`关闭 ${tab.name}`}
                className="mr-1 rounded p-0.5 text-text-muted opacity-0 transition-opacity hover:bg-surface-hover hover:text-text group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
