/**
 * 对话区域 — 消息列表 + 输入框
 *
 * 事件按 type 路由渲染（细粒度渲染在 MessageList 内）：
 * text / thinking / tool_call / tool_result / error / done。
 *
 * 布局：
 * - 顶栏 / 输入区为玻璃拟态
 * - 助手正文为描边圆角卡片（外观由皮肤 token 决定）
 */

import { useRef, useState } from "react";
import {
  useChatStore,
  selectCurrentStreaming,
  selectEffectiveAgentId,
} from "../stores/chat";
import {
  Send,
  Square,
  ChevronRight,
  PanelRightClose,
  PanelRightOpen,
  X,
} from "lucide-react";
import { AgentSelector } from "./AgentSelector";
import { ProjectSelector } from "./ProjectSelector";
import { useFileMention, FileMentionPopup } from "./FileMention";
import { AssistantMessageList } from "./AssistantMessageList";
import { FileTypeIcon } from "./ui/FileTypeIcon";
import { FolderTypeIcon } from "./ui/FolderTypeIcon";

// ============================================================================
// 对话主区域
// ============================================================================

export function ChatArea({ embedded = false }: { embedded?: boolean } = {}) {
  const isStreaming = useChatStore(selectCurrentStreaming);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const abort = useChatStore((s) => s.abort);
  const projects = useChatStore((s) => s.projects);
  const sessions = useChatStore((s) => s.sessions);
  const currentProjectId = useChatStore((s) => s.currentProjectId);
  const currentSessionId = useChatStore((s) => s.currentSessionId);

  const currentProject = projects.find((p) => p.id === currentProjectId);
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  /**
   * 会话一旦创建（currentSessionId 已确定），本次会话由哪个 Agent 执行就定死了：
   * 输入框旁的 Agent 选择器随之锁定。未创建时它决定"新会话用谁"。
   */
  const agentLocked = currentSessionId !== null;
  const effectiveAgentId = useChatStore(selectEffectiveAgentId);
  const agents = useChatStore((s) => s.agents);
  const selectAgent = useChatStore((s) => s.selectAgent);
  const showWorkspace = useChatStore((s) => s.showWorkspace);
  const setShowWorkspace = useChatStore((s) => s.setShowWorkspace);
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fileMention = useFileMention({
    cwd: currentProject?.cwd ?? "",
    input,
    setInput,
    textareaRef,
  });
  const handleSend = () => {
    const trimmed = input.trim();
    const references = fileMention.references;
    if ((!trimmed && references.length === 0) || isStreaming) return;
    const referenceText = references
      .map((entry) => `@${entry.relativePath}`)
      .join(" ");
    const prompt = [trimmed, referenceText].filter(Boolean).join(" ");
    setInput("");
    fileMention.clearReferences();
    sendMessage(prompt);
  };

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {/* 主体纸面：顶栏 / 消息区 / 输入区同属一张纸，浮在画布底色之上 */}
      <div
        className={
          embedded
            ? "relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden"
            : "ui-page relative z-10 flex flex-1 flex-col overflow-hidden rounded-xl"
        }
      >
        {/* 顶栏：会话标题 › 绑定的工作目录 */}
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-1.5 text-body-lg">
            <span className="truncate text-text-secondary">
              {currentSession?.title ?? "新会话"}
            </span>
            {currentProject && (
              <>
                <ChevronRight className="h-3 w-3 shrink-0 text-text-muted" />
                <FolderTypeIcon size={13} />
                <span className="truncate font-mono text-caption text-text-muted">
                  {currentProject.cwd}
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowWorkspace(!showWorkspace)}
            title={showWorkspace ? "隐藏工作区文件" : "显示工作区文件"}
            aria-label={showWorkspace ? "隐藏工作区文件" : "显示工作区文件"}
            aria-pressed={showWorkspace}
            className={`ui-btn-round ui-icon-action flex size-icon-btn shrink-0 items-center justify-center rounded-full ${
              showWorkspace ? "text-accent" : ""
            }`}
          >
            {showWorkspace ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
          </button>
        </header>

        {/* 消息区由 assistant-ui 运行时渲染，视觉仍由 Nova token 控制 */}
        <div className="relative z-10 min-h-0 flex-1 overflow-hidden">
          <AssistantMessageList />
        </div>

        {/* 输入区：玻璃拟态 + 大圆角描边卡片 */}
        <div className="ui-glass relative z-10 border-t border-border p-inset">
          <div className="mx-auto max-w-[var(--c-layout-content)]">
            <div className="ui-ring rounded-[var(--c-radius-input)] bg-input-bg p-2 shadow-[var(--c-shadow-sm)] focus-within:shadow-[0_0_0_2px_var(--c-accent-soft)]">
              {fileMention.references.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5 px-1">
                  {fileMention.references.map((entry) => (
                    <span
                      key={entry.relativePath}
                      title={entry.relativePath}
                      className="flex max-w-64 items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2 py-1 text-caption font-medium text-accent"
                    >
                      <FileTypeIcon name={entry.name} size={13} />
                      <span className="truncate">{entry.name}</span>
                      <button
                        type="button"
                        onClick={() => fileMention.removeReference(entry.relativePath)}
                        title={`移除 ${entry.name}`}
                        className="rounded-full p-0.5 text-current opacity-70 hover:bg-surface-hover hover:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <div className="relative flex flex-1 items-end">
                  <textarea
                    ref={textareaRef}
                    // 启动时把焦点留在输入框：否则 Chromium 的初始焦点会落到
                    // DOM 里第一个可聚焦元素（侧栏「新建会话」按钮）上。
                    // autoFocus 只在挂载时生效，不会在后续渲染里抢焦点。
                    autoFocus
                    value={input}
                    onChange={(e) => fileMention.handleChange(e)}
                    onKeyDown={(e) => {
                      if (fileMention.handleKeyDown(e)) return;
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder="输入消息，@ 提及文件，Enter 发送，Shift+Enter 换行"
                    rows={1}
                    className="max-h-40 flex-1 resize-none bg-transparent px-3 py-2 text-body-lg text-text placeholder-text-muted outline-none"
                  />
                  {fileMention.active && (
                    <FileMentionPopup
                      items={fileMention.items}
                      hoverIdx={fileMention.hoverIdx}
                      loading={fileMention.loading}
                      onHover={fileMention.setHoverIdx}
                      onSelect={fileMention.selectEntry}
                      popupRef={fileMention.popupRef}
                      itemRefs={fileMention.itemRefs}
                    />
                  )}
                </div>
              {/* 工作目录：可选。绑定后 Agent 在该项目目录运行 */}
              <ProjectSelector />
              {/* 本次会话使用的 Agent：新会话可选，会话开始后锁定 */}
              <AgentSelector
                agents={agents}
                agentId={effectiveAgentId}
                locked={agentLocked}
                onSelect={selectAgent}
              />
              {isStreaming ? (
                <button
                  onClick={() => abort()}
                  title="停止运行"
                  className="ui-btn-primary flex size-icon-btn shrink-0 items-center justify-center rounded-full"
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  title="发送"
                  className="ui-btn-primary flex size-icon-btn shrink-0 items-center justify-center rounded-full"
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
