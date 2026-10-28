/**
 * 中间内容区域：标签栏 + 对话 / 文件预览
 */

import { useFileViewerStore } from "../stores/fileViewer";
import { ChatArea } from "./ChatArea";
import { CenterTabs } from "./CenterTabs";
import { FilePreview } from "./FilePreview";

export function CenterPane() {
  const tabs = useFileViewerStore((s) => s.tabs);
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <CenterTabs />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className={activeTab ? "hidden" : "h-full"}>
          <ChatArea embedded />
        </div>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={activeTabId === tab.id ? "h-full" : "hidden"}
          >
            <FilePreview tab={tab} />
          </div>
        ))}
      </div>
    </div>
  );
}
