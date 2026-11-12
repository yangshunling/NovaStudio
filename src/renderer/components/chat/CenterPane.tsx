/**
 * 中间内容区域：标签栏 + 对话 / 文件预览 / 终端
 *
 * 终端与其他中心视图一样保持挂载，仅切换显隐，避免切换标签时重启 PTY。
 */

import { lazy, Suspense } from "react";
import { useChatStore } from "../../stores/chat";
import { useFileViewerStore } from "../../stores/fileViewer";
import { useTerminalStore } from "../../stores/terminal";
import { ChatArea } from "./ChatArea";
import { CenterTabs } from "./CenterTabs";
import { Spinner } from "../ui/Spinner";

/*
 * 文件预览与终端都是“打开标签后才需要”的重资源：
 * - 终端会引入整个 xterm；
 * - 文件预览会引入 PDF / 图片 / Markdown 预览链路。
 * 懒加载后它们不再进入首屏 chunk，但组件仍然常驻挂载，切换标签不重启 PTY。
 */
const FilePreview = lazy(() =>
  import("../files/FilePreview").then((m) => ({ default: m.FilePreview })),
);
const TerminalView = lazy(() =>
  import("../terminal/TerminalView").then((m) => ({
    default: m.TerminalView,
  })),
);

function TabFallback() {
  return (
    <div className="flex h-full items-center justify-center text-text-muted">
      <Spinner className="h-5 w-5" />
    </div>
  );
}

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
            {/*
              非活动文件标签只保留元数据：FilePreview 会读取并保留最多 2MB
              文本 / 图片 data URL，全部常驻会让打开十几个大文件后内存持续上涨。
              切回该标签时重新读取即可。
            */}
            {activeTabId === tab.id && (
              <Suspense fallback={<TabFallback />}>
                <FilePreview tab={tab} />
              </Suspense>
            )}
          </div>
        ))}
        {terminals.map((tab) => (
          <div
            key={tab.id}
            className={activeTabId === tab.id ? "h-full" : "hidden"}
          >
            <Suspense fallback={<TabFallback />}>
              <TerminalView
                tab={tab}
                showWorkspace={showWorkspace}
                onToggleWorkspace={() => setShowWorkspace(!showWorkspace)}
              />
            </Suspense>
          </div>
        ))}
      </div>
    </div>
  );
}
