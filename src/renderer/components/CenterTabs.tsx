/**
 * 中间区域标签栏：对话 + 已打开文件
 */

import { MessageSquare, X } from "lucide-react";
import { useFileViewerStore } from "../stores/fileViewer";
import { FileTypeIcon } from "./ui/FileTypeIcon";

export function CenterTabs() {
  const tabs = useFileViewerStore((s) => s.tabs);
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const activateTab = useFileViewerStore((s) => s.activateTab);
  const closeTab = useFileViewerStore((s) => s.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div className="ui-glass relative z-20 flex h-10 shrink-0 items-center border-b border-border px-2">
      <button
        type="button"
        onClick={() => activateTab(null)}
        className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-meta transition-colors ${
          activeTabId === null
            ? "bg-surface-active text-text"
            : "text-text-secondary hover:bg-surface-hover hover:text-text"
        }`}
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
              className={`group flex h-7 max-w-52 min-w-0 shrink-0 items-center rounded-md border transition-colors ${
                active
                  ? "border-border-strong bg-surface-active text-text"
                  : "border-transparent text-text-secondary hover:bg-surface-hover hover:text-text"
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
                onClick={() => closeTab(tab.id)}
                title={`关闭 ${tab.name}`}
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
