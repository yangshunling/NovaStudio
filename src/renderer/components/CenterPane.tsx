/**
 * 中间内容区域：标签栏 + 对话 / 文件预览
 */

import { useFileViewerStore } from "../stores/fileViewer";
import { ChatArea } from "./ChatArea";
import { CenterTabs } from "./CenterTabs";
import { FilePreview } from "./FilePreview";
import { SkinStage } from "./SkinStage";
import { TerminalView } from "./TerminalView";

export function CenterPane() {
  const tabs = useFileViewerStore((s) => s.tabs);
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  return (
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <SkinStage />
      <div className="ui-page relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
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
              {tab.kind === "file" ? (
                <FilePreview tab={tab} />
              ) : (
                <TerminalView tab={tab} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
