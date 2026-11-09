/**
 * 中间内容区域：标签栏 + 对话 / 文件预览 / 终端
 *
 * 终端与其他中心视图一样保持挂载，仅切换显隐，避免切换标签时重启 PTY。
 */

import { useChatStore } from "../../stores/chat";
import { useFileViewerStore } from "../../stores/fileViewer";
import { useTerminalStore } from "../../stores/terminal";
import { ChatArea } from "./ChatArea";
import { CenterTabs } from "./CenterTabs";
import { FilePreview } from "../files/FilePreview";
import { TerminalView } from "../terminal/TerminalView";

export function CenterPane() {
  const tabs = useFileViewerStore((s) => s.tabs);
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const terminals = useTerminalStore((s) => s.terminals);
  const showWorkspace = useChatStore((s) => s.showWorkspace);
  const setShowWorkspace = useChatStore((s) => s.setShowWorkspace);

  /** 活动标签被外部关闭（如删除工作区）时回落到对话，避免整块空白 */
  const activeExists =
    activeTabId !== null &&
    (tabs.some((tab) => tab.id === activeTabId) ||
      terminals.some((tab) => tab.id === activeTabId));
  const showChat = activeTabId === null || !activeExists;

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <CenterTabs />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className={showChat ? "h-full" : "hidden"}>
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
        {terminals.map((tab) => (
          <div
            key={tab.id}
            className={activeTabId === tab.id ? "h-full" : "hidden"}
          >
            <TerminalView
              tab={tab}
              showWorkspace={showWorkspace}
              onToggleWorkspace={() => setShowWorkspace(!showWorkspace)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
