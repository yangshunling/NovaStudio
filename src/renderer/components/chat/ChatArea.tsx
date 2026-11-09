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

import { useCallback, useEffect, useRef } from "react";
import {
  NEW_SESSION_DRAFT_KEY,
  useChatStore,
  selectCurrentStreaming,
  selectEffectiveAgentId,
} from "../../stores/chat";
import {
  Send,
  Square,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  X,
} from "lucide-react";
import { AgentSelector } from "./AgentSelector";
import { ProjectSelector } from "./ProjectSelector";
import { useFileMention, FileMentionPopup } from "./FileMention";
import { AssistantMessageList } from "./AssistantMessageList";
import { PromptPicker } from "./PromptPicker";
import { QuestionNav } from "./QuestionNav";
import { FileTypeIcon } from "../ui/FileTypeIcon";
import { PageHeader } from "../ui/Page";
import { toast } from "../../stores/toast";
import { toMessage } from "../../lib/utils";

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
  /**
   * 只有一个可用 Agent 时选择器没有意义（当前只有 Claude Code）：
   * 自动选中即可，不占输入框的空间。将来接入第二个 Agent 时自动出现。
   */
  const hasAgentChoice =
    agents.filter((agent) => agent.status.installed).length > 1;
  const showWorkspace = useChatStore((s) => s.showWorkspace);
  const setShowWorkspace = useChatStore((s) => s.setShowWorkspace);
  /**
   * 草稿按会话隔离：未创建会话时放在 __new__ 桶里。
   * 这样切走再回来内容还在，也不会把 A 会话的草稿带进 B 会话。
   */
  const draftKey = currentSessionId ?? NEW_SESSION_DRAFT_KEY;
  const input = useChatStore((s) => s.draftsBySession[draftKey] ?? "");
  const setDraft = useChatStore((s) => s.setDraft);
  const setInput = useCallback(
    (value: string) => setDraft(draftKey, value),
    [draftKey, setDraft],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingPrompt = useChatStore((s) => s.pendingPrompt);
  const consumePendingPrompt = useChatStore((s) => s.consumePendingPrompt);

  /** 把提示词正文接到现有草稿后面，并把光标移到末尾 */
  const appendToInput = useCallback(
    (content: string) => {
      const text = content.trim();
      if (!text) return;
      const previous =
        useChatStore.getState().draftsBySession[draftKey] ?? "";
      setDraft(draftKey, previous.trim() ? `${previous}\n\n${text}` : text);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
        textarea.scrollTop = textarea.scrollHeight;
      });
    },
    [draftKey, setDraft],
  );

  // 从「提示词」页点「在对话中使用」后，正文在这里落进输入框
  useEffect(() => {
    if (pendingPrompt === null) return;
    const content = consumePendingPrompt();
    if (content) appendToInput(content);
  }, [pendingPrompt, consumePendingPrompt, appendToInput]);

  const fileMention = useFileMention({
    draftKey,
    projectId: currentProject?.id ?? "",
    input,
    setInput,
    textareaRef,
  });
  const handleSend = () => {
    const trimmed = input.trim();
    const references = fileMention.references;
    // 流式中再次提交会被主进程拒绝，但仍清空了输入框：这里直接短路
    if ((!trimmed && references.length === 0) || isStreaming) return;
    const referenceText = references
      .map((entry) => `@${entry.relativePath}`)
      .join(" ");
    const prompt = [trimmed, referenceText].filter(Boolean).join(" ");
    setInput("");
    fileMention.clearReferences();
    // 会话创建 / Agent 缺失等前置失败不会进入消息流：把输入还给用户并提示
    void sendMessage(prompt).catch((err) => {
      setInput(trimmed);
      toast.error(toMessage(err), 5000);
    });
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
        {/* 顶栏：会话标题 + 绑定的工作目录 */}
        <PageHeader
          icon={<MessageSquare className="h-4 w-4" />}
          title={currentSession?.title ?? "新会话"}
          subtitle={currentProject?.cwd}
          actions={
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
          }
        />

        {/* 消息区由 assistant-ui 运行时渲染，视觉仍由 Nova token 控制 */}
        <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden">
          <div className="relative min-h-0 min-w-0 flex-1">
            <AssistantMessageList
              onSuggestion={(text) => {
                // 示例只填入输入框，发不发送由用户决定
                setInput(text);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            />
          </div>
          {/*
            问题导航浮在消息区最右侧，不占布局宽度：
            否则消息区与下方输入框的左右边界会对不齐。
          */}
          <QuestionNav />
        </div>

        {/* 输入区：玻璃拟态 + 大圆角描边卡片 */}
        <div className="ui-glass ui-chat-gutter relative z-10 border-t border-border py-inset">
          <div className="mx-auto max-w-[var(--c-layout-content)]">
            <div className="ui-ring rounded-[var(--c-radius-input)] bg-input-bg p-2 shadow-[var(--c-shadow-sm)] transition-[border-color,box-shadow] focus-within:border-accent/40 focus-within:shadow-[0_0_0_3px_var(--c-accent-soft)]">
              {fileMention.references.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5 px-1">
                  {fileMention.references.map((entry) => (
                    <span
                      key={entry.relativePath}
                      title={entry.relativePath}
                      className="flex max-w-64 items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2 py-1 text-meta font-medium text-accent"
                    >
                      <FileTypeIcon name={entry.name} size={13} />
                      <span className="truncate">{entry.name}</span>
                      <button
                        type="button"
                        onClick={() => fileMention.removeReference(entry.relativePath)}
                        title={`移除 ${entry.name}`}
                        aria-label={`移除引用文件 ${entry.name}`}
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
                      // 中文输入法选词时的回车不能当发送：
                      // 否则会把还没上屏的拼音当成完整消息发出去
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder={
                      currentProject
                        ? "输入消息，@ 提及文件，Enter 发送，Shift+Enter 换行"
                        : "描述任务，Enter 发送；绑定工作区后可用 @ 提及文件"
                    }
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
              {/* 工作目录：可选。绑定后 Agent 在该工作区目录运行 */}
              <ProjectSelector />
              {/* 常用提示词：选中后插入输入框，由用户确认后再发送 */}
              <PromptPicker onPick={appendToInput} />
              {/* 有多个可用 Agent 时才需要选择；否则自动使用唯一的那个 */}
              {hasAgentChoice && (
                <AgentSelector
                  agents={agents}
                  agentId={effectiveAgentId}
                  locked={agentLocked}
                  onSelect={selectAgent}
                />
              )}
              {isStreaming ? (
                <button
                  onClick={() => abort()}
                  title="停止运行"
                  aria-label="停止运行"
                  className="ui-btn-danger-soft flex size-icon-btn shrink-0 items-center justify-center rounded-full"
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim() && fileMention.references.length === 0}
                  title="发送"
                  aria-label="发送消息"
                  className="ui-btn-primary flex size-icon-btn shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-40"
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
