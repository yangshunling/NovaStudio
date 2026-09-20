/**
 * 对话区域 — 消息列表 + 输入框
 *
 * 事件按 type 路由渲染（细粒度渲染在 MessageList 内）：
 * text / thinking / tool_call / tool_result / error / done。
 *
 * 布局：
 * - 装饰舞台（背景 + 立绘）挂在 main 内部，由当前皮肤决定是否渲染
 * - 顶栏 / 输入区为玻璃拟态
 * - 助手正文为描边圆角卡片（外观由皮肤 token 决定）
 */

import { useRef, useState, useEffect } from "react";
import {
  useChatStore,
  selectCurrentMessages,
  selectCurrentStreaming,
  selectEffectiveAgentId,
} from "../stores/chat";
import { Send, Square, ChevronRight, Folder } from "lucide-react";
import { SkinStage } from "./SkinStage";
import { AgentOptionsMenu } from "./AgentOptionsMenu";
import { AgentSelector } from "./AgentSelector";
import { MessageGroup, StreamingIndicator } from "./MessageList";

// ============================================================================
// 对话主区域
// ============================================================================

export function ChatArea() {
  const messages = useChatStore(selectCurrentMessages);
  const isStreaming = useChatStore(selectCurrentStreaming);
  /**
   * 当前会话的历史是否正在回放（显示进度条）。
   * 必须显式排除 null：空闲态下 loadingHistoryFor 与 currentSessionId
   * 均为 null，null === null 会误判为正在回放（例如点击「新建会话」
   * 把 currentSessionId 置空时）。
   */
  const isLoadingHistory = useChatStore(
    (s) => s.loadingHistoryFor !== null && s.loadingHistoryFor === s.currentSessionId,
  );
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
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * 是否跟随最新内容：默认贴底，用户主动上滑查看历史时暂停跟随，
   * 回到底部附近后自动恢复 —— 流式输出（含长思考）期间无需手动滚动。
   */
  const stickToBottom = useRef(true);

  // 自动滚动到底部（贴底状态下每次内容变化都跟随）
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isStreaming]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput("");
    sendMessage(trimmed);
  };

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      {/* 装饰舞台：背景 + 立绘，由皮肤声明决定是否渲染 */}
      <SkinStage />

      {/* 主体纸面：顶栏 / 消息区 / 输入区同属一张纸，浮在画布底色之上 */}
      <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden rounded-xl">
        {/* 顶栏：项目 › 会话 面包屑 */}
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-1.5 text-body-lg">
            {currentProject ? (
              <>
                <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="truncate font-mono text-caption text-text-muted">
                  {currentProject.cwd}
                </span>
                {currentSession && (
                  <>
                    <ChevronRight className="h-3 w-3 shrink-0 text-text-muted" />
                    <span className="truncate text-text-secondary">{currentSession.title}</span>
                  </>
                )}
              </>
            ) : (
              <span className="text-text-muted">Nova</span>
            )}
          </div>
        </header>

        {/* 消息区：透明，让纸面 / 舞台透出；
            ui-chat-scale：本区域字号独立于全局设置（见 styles/index.css） */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="ui-chat-scale relative z-10 flex-1 overflow-y-auto px-4 py-4"
        >
          <div className="mx-auto max-w-[var(--c-layout-content)]">
            {messages.length === 0 && (
              <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-3 text-text-muted">
                {isLoadingHistory ? (
                  /* 历史回放中：居中的等待卡片（观感随皮肤自适应） */
                  <div className="history-loading ui-glass ui-ring flex w-[260px] flex-col items-center gap-4 rounded-lg px-6 py-6">
                    <div className="history-progress">
                      <div className="history-progress-bar" />
                    </div>
                    <p className="ui-serif text-body tracking-wide text-text-secondary">
                      历史记录正在恢复中
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="ui-btn-round flex h-14 w-14 items-center justify-center rounded-full">
                      <Send className="h-5 w-5" />
                    </div>
                    <h1 className="ui-serif text-hero font-semibold tracking-wide text-text-secondary">
                      {currentProject ? "开始对话" : "Nova 女仆工坊"}
                    </h1>
                    <p className="text-body-lg">
                      {currentProject
                        ? `在 ${currentProject.name} 里与智能体对话`
                        : "从左侧选择或创建一个项目"}
                    </p>
                  </>
                )}
              </div>
            )}
            {messages.map((msg) => (
              <MessageGroup key={msg.id} isUser={msg.role === "user"} events={msg.content} />
            ))}
            {isStreaming && (
              <div className="flex items-center gap-2 px-1 text-body-lg text-text-muted">
                <StreamingIndicator />
              </div>
            )}
          </div>
        </div>

        {/* 输入区：玻璃拟态 + 大圆角描边卡片 */}
        <div className="ui-glass relative z-10 border-t border-border p-inset">
          <div className="mx-auto max-w-[var(--c-layout-content)]">
            <div className="ui-ring flex items-end gap-2 rounded-[var(--c-radius-input)] bg-input-bg p-2 focus-within:shadow-[0_0_0_2px_var(--c-accent-soft)]">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="输入消息，Enter 发送，Shift+Enter 换行"
                rows={1}
                className="max-h-40 flex-1 resize-none bg-transparent px-3 py-2 text-body-lg text-text placeholder-text-muted outline-none"
              />
              {/* 本次会话使用的 Agent：新会话可选，会话开始后锁定 */}
              <AgentSelector
                agents={agents}
                agentId={effectiveAgentId}
                locked={agentLocked}
                onSelect={selectAgent}
              />
              {/* 运行参数：由当前 Agent 的 manifest.options 决定是否出现 */}
              <AgentOptionsMenu />
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
    </main>
  );
}
