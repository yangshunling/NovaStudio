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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  EMPTY_QUEUE,
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
  Sparkles,
  Wrench,
  Library,
  ListOrdered,
  Keyboard,
  X,
} from "lucide-react";
import { AgentSelector } from "./AgentSelector";
import { EmployeeSelector } from "./EmployeeSelector";
import { ProjectSelector } from "./ProjectSelector";
import {
  useMention,
  MentionPopup,
  type MentionReference,
} from "./MentionPicker";
import { AssistantMessageList } from "./AssistantMessageList";
import { ContextGauge } from "./ContextGauge";
import { useWorkspacePicker } from "./WorkspacePicker";
import { useInputHistory } from "../../hooks/useInputHistory";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { useComposerSubmit, usePasteNormalizer } from "./useComposer";
import { WorkspaceMenuPanel } from "./WorkspaceMenu";
import { QuestionNav } from "./QuestionNav";
import { FileTypeIcon } from "../ui/FileTypeIcon";
import { PageHeader } from "../ui/Page";
import { IconButton } from "../ui/IconButton";
import { toast } from "../../stores/toast";
import { toMessage } from "../../lib/utils";
import { FOCUS_COMPOSER_EVENT } from "../../lib/chat-events";

/** 引用标签的图标：文件按扩展名，其余按引用类型 */
function ReferenceIcon({ reference }: { reference: MentionReference }) {
  switch (reference.category) {
    case "file":
      return <FileTypeIcon name={reference.name} size={13} />;
    case "tool":
      return <Wrench className="h-3.5 w-3.5" />;
    case "skill":
      return <Sparkles className="h-3.5 w-3.5" />;
    case "knowledge":
      return <Library className="h-3.5 w-3.5" />;
  }
}

// ============================================================================
// 对话主区域
// ============================================================================

export function ChatArea({ embedded = false }: { embedded?: boolean } = {}) {
  const isStreaming = useChatStore(selectCurrentStreaming);
  /** 已发出停止、但主进程还在收尾：此时发送应进入暂存区，不能开新轮 */
  const isStopping = useChatStore((s) =>
    s.currentSessionId ? !!s.stoppingBySession[s.currentSessionId] : false,
  );
  const isBusy = isStreaming || isStopping;
  const sendMessage = useChatStore((s) => s.sendMessage);
  const abort = useChatStore((s) => s.abort);
  /** 当前会话的暂存区：运行中继续发送的消息排在这里 */
  const queued = useChatStore((s) =>
    s.currentSessionId
      ? (s.queuedBySession[s.currentSessionId] ?? EMPTY_QUEUE)
      : EMPTY_QUEUE,
  );
  const removeQueuedMessage = useChatStore((s) => s.removeQueuedMessage);
  const resumeQueue = useChatStore((s) => s.resumeQueue);
  const projects = useChatStore((s) => s.projects);
  const sessions = useChatStore((s) => s.sessions);
  const currentProjectId = useChatStore((s) => s.currentProjectId);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  /** 当前会话的上下文占用；切换会话 / 每轮 usage 到达时自动更新 */
  const usage = useChatStore((s) =>
    s.currentSessionId
      ? (s.usageBySession[s.currentSessionId] ?? null)
      : null,
  );

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

  /*
   * 点击左侧会话时，把焦点交还输入框。
   *
   * 输入框常驻挂载，autoFocus 只在首次挂载生效，切换会话不会再次聚焦；
   * 这里监听会话列表广播的意图事件，等标签切换完成后再落焦点。
   */
  useEffect(() => {
    const focusComposer = () => {
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        // 文件预览 / 终端标签可能仍盖在对话区上：不可见时不抢焦点
        if (!textarea || textarea.offsetParent === null) return;
        textarea.focus({ preventScroll: true });
      });
    };
    window.addEventListener(FOCUS_COMPOSER_EVENT, focusComposer);
    return () =>
      window.removeEventListener(FOCUS_COMPOSER_EVENT, focusComposer);
  }, []);

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

  /**
   * 输入框随内容自动增高。
   *
   * textarea 的 rows={1} 只决定初始高度，多行内容（例如带格式的提示词）
   * 会被压在一行里只露出第一行。这里按 scrollHeight 撑开，最大高度由
   * CSS 的 max-h-48 限制，超过后在框内滚动。
   */
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    // 隐藏状态下量不到内容高度，退回 CSS 的 min-height
    textarea.style.height =
      textarea.scrollHeight > 0 ? `${textarea.scrollHeight}px` : "";
  }, [input]);

  /** ↑ / ↓ 翻找已发送正文：跨会话共享，草稿在翻回底部时原样还原 */
  const history = useInputHistory({
    value: input,
    setValue: setInput,
    textareaRef,
    scopeKey: draftKey,
  });

  const mention = useMention({
    draftKey,
    projectId: currentProject?.id ?? "",
    input,
    setInput,
    textareaRef,
  });
  /** `#` 快捷切换工作区；与 `@` 共用同一个输入框和弹窗位置 */
  const workspacePicker = useWorkspacePicker({
    draftKey,
    input,
    setInput,
    textareaRef,
  });
  const handlePaste = usePasteNormalizer(setInput);

  /** 输入快捷键帮助：完整说明放在弹层里，避免窄窗口下占位文本被截断 */
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  useDismissableLayer(helpOpen, () => setHelpOpen(false), [helpRef]);
  const shortcutRows: Array<[string, string]> = [
    ["Enter", "发送消息"],
    ["Shift + Enter", "换行"],
    ["@", "选择数字员工"],
    ["/", "引用文件 / 技能 / 知识库"],
    ["#", "切换工作区"],
    ["↑ / ↓", "翻找已发送内容"],
  ];

  /** 占位提示用独立的一行文本渲染：textarea 原生 placeholder 会自动折行 */
  const placeholder = currentProject
    ? "输入消息，@ 选数字员工，/ 引用内容，# 切换工作区，Enter 发送，Shift+Enter 换行"
    : "描述任务，@ 选数字员工，/ 引用内容，# 切换工作区，Enter 发送，Shift+Enter 换行";

  const handleSend = useComposerSubmit({
    input,
    references: mention.references,
    clearReferences: mention.clearReferences,
    restoreReferences: mention.restoreReferences,
    setInput,
    pushHistory: history.push,
    sendMessage,
  });

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
            <IconButton
              icon={
                showWorkspace ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRightOpen className="h-4 w-4" />
                )
              }
              label={showWorkspace ? "隐藏工作区文件" : "显示工作区文件"}
              size="icon"
              aria-pressed={showWorkspace}
              className={showWorkspace ? "text-accent" : ""}
              onClick={() => setShowWorkspace(!showWorkspace)}
            />
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

        {/* 输入区：一张书写纸 —— 正文在上，操作栏在下 */}
        <div className="ui-chat-gutter relative z-10 border-t border-border bg-bg py-3">
          <div className="mx-auto w-full max-w-[var(--c-layout-content)]">
            <div className="rounded-input border border-border/80 bg-input-bg px-3 py-2 shadow-[var(--c-shadow-sm)] transition-[border-color,box-shadow] focus-within:border-accent/40 focus-within:shadow-[0_0_0_3px_var(--c-accent-soft)]">
              {/* 暂存区：本轮运行中继续发送的消息按序排在这里，结束后自动接力 */}
              {queued.length > 0 && (
                <div className="mb-2 overflow-hidden rounded-md border border-border/70 bg-surface-2/70">
                  <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
                    <ListOrdered className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                    <span className="shrink-0 ui-type-sub font-semibold tracking-[0.08em] text-text-secondary">
                      暂存区
                    </span>
                    <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm border border-border bg-surface px-1 ui-type-sub tabular-nums text-text-muted">
                      {queued.length}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 ui-type-sub text-text-muted">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          isBusy
                            ? "animate-pulse bg-accent"
                            : "bg-text-muted"
                        }`}
                      />
                      <span className="truncate">
                        {isStopping
                          ? "正在停止本轮…"
                          : isStreaming
                            ? "本轮结束后自动发送"
                            : "已暂停"}
                      </span>
                    </span>
                    {!isBusy && (
                      <button
                        type="button"
                        onClick={() => resumeQueue()}
                        title="立即发送暂存区中的下一条"
                        className="ml-auto shrink-0 rounded-sm px-1.5 py-0.5 ui-type-sub font-medium text-accent transition-colors hover:bg-accent/10"
                      >
                        继续发送
                      </button>
                    )}
                  </div>
                  <ul className="max-h-28 overflow-y-auto px-1.5 py-1">
                    {queued.map((item, index) => (
                      <li
                        key={item.id}
                        className="group flex items-start gap-2 rounded-sm px-1.5 py-1 transition-colors hover:bg-surface-hover/50"
                      >
                        <span className="mt-0.5 w-5 shrink-0 text-right ui-type-sub tabular-nums text-text-muted/80">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span
                          title={item.display}
                          className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap ui-type-note leading-relaxed text-text-secondary"
                        >
                          {item.display}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeQueuedMessage(item.id)}
                          title="从暂存区移除"
                          aria-label="从暂存区移除"
                          className="mt-0.5 shrink-0 rounded-sm p-0.5 text-text-muted opacity-0 transition-all hover:bg-surface-hover hover:text-text group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {mention.references.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5 px-1">
                  {mention.references.map((reference) => (
                    <span
                      key={reference.key}
                      title={reference.detail || reference.name}
                      className="flex max-w-64 items-center gap-1.5 rounded-md border border-border/60 bg-surface-hover/40 px-2 py-1 ui-type-sub text-text-secondary"
                    >
                      <ReferenceIcon reference={reference} />
                      <span className="truncate">{reference.name}</span>
                      <button
                        type="button"
                        onClick={() => mention.removeReference(reference.key)}
                        title={`移除 ${reference.name}`}
                        aria-label={`移除引用 ${reference.name}`}
                        className="rounded-sm p-0.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* 正文：独占整行，宽度不再被右侧控件挤占 */}
              <div className="relative">
                <textarea
                  ref={textareaRef}
                  aria-label="消息输入"
                  // 启动时把焦点留在输入框：否则 Chromium 的初始焦点会落到
                  // DOM 里第一个可聚焦元素（侧栏「新建会话」按钮）上。
                  // autoFocus 只在挂载时生效，不会在后续渲染里抢焦点。
                  autoFocus
                  value={input}
                  onChange={(e) => {
                    mention.handleChange(e);
                    workspacePicker.handleChange(e);
                  }}
                  onPaste={handlePaste}
                  onKeyDown={(e) => {
                    // 中文输入法选词时的回车 / 方向键不能当发送、翻历史或
                    // 弹窗确认：否则会把还没上屏的拼音当成完整消息发出去。
                    // 必须放在最前面，早于 @ / # 弹窗的按键处理。
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (mention.handleKeyDown(e)) return;
                    if (workspacePicker.handleKeyDown(e)) return;
                    // ↑ / ↓ 翻找历史发送正文（Esc 退出浏览并还原草稿）。
                    // 弹窗开着时方向键属于弹窗（哪怕列表为空），不接管
                    if (mention.active || workspacePicker.active) return;
                    if (history.handleKeyDown(e)) return;
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder=""
                  rows={1}
                  className="max-h-48 min-h-[36px] w-full resize-none bg-transparent px-1.5 py-1 ui-type-item leading-relaxed text-text placeholder-text-muted outline-none"
                />
                {input.length === 0 && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 select-none truncate px-1.5 py-1 ui-type-item leading-relaxed text-text-muted"
                  >
                    {placeholder}
                  </span>
                )}
                {mention.active ? (
                  <MentionPopup
                    kind={mention.kind}
                    entries={mention.entries}
                    hoverIdx={mention.hoverIdx}
                    loading={mention.loading}
                    emptyHint={mention.emptyHint}
                    headerLabel={mention.headerLabel}
                    canBack={mention.canBack}
                    onBack={mention.goBack}
                    onHover={mention.setHoverIdx}
                    onSelect={mention.selectEntry}
                    popupRef={mention.popupRef}
                    itemRefs={mention.itemRefs}
                  />
                ) : workspacePicker.active ? (
                  <WorkspaceMenuPanel
                    items={workspacePicker.entries}
                    hoverIdx={workspacePicker.hoverIdx}
                    emptyHint={workspacePicker.emptyHint}
                    onHover={workspacePicker.setHoverIdx}
                    onSelect={workspacePicker.selectEntry}
                    popupRef={workspacePicker.popupRef}
                    itemRefs={workspacePicker.itemRefs}
                  />
                ) : null}
              </div>

              {/* 操作栏：左边是上下文，右边是仪表与发送。
                  分隔线与上下内容的间距对齐（正文尾部 ~9px / 按钮上方 8px），
                  线条大致落在留白中间，而不是紧贴按钮。 */}
              <div className="mt-0 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
                <div className="flex min-w-0 items-center gap-1">
                  {/* 工作目录：可选。绑定后 Agent 在该工作区目录运行 */}
                  <ProjectSelector />
                  {/* 数字员工：可选。选中后本次会话使用其提示词与能力 */}
                  <EmployeeSelector />
                  {/* 有多个可用 Agent 时才需要选择；否则自动使用唯一的那个 */}
                  {hasAgentChoice && (
                    <AgentSelector
                      agents={agents}
                      agentId={effectiveAgentId}
                      locked={agentLocked}
                      onSelect={selectAgent}
                    />
                  )}
                  <div className="relative" ref={helpRef}>
                    <button
                      type="button"
                      onClick={() => setHelpOpen((value) => !value)}
                      aria-label="输入快捷键说明"
                      aria-expanded={helpOpen}
                      title="输入快捷键说明"
                      className={`rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text ${
                        helpOpen ? "bg-surface-hover text-text" : ""
                      }`}
                    >
                      <Keyboard className="h-3.5 w-3.5" />
                    </button>
                    {helpOpen && (
                      <div className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-border bg-surface p-3 shadow-[var(--c-shadow)]">
                        <p className="mb-2 ui-type-sub font-semibold text-text-secondary">
                          输入快捷键
                        </p>
                        <dl className="space-y-1.5">
                          {shortcutRows.map(([key, label]) => (
                            <div
                              key={key}
                              className="flex items-center justify-between gap-3 ui-type-note"
                            >
                              <dt className="text-text-muted">{label}</dt>
                              <dd className="shrink-0 rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 ui-type-code-sm text-text-secondary">
                                {key}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <ContextGauge usage={usage} agentId={effectiveAgentId} />
                  <button
                    onClick={handleSend}
                    disabled={!input.trim() && mention.references.length === 0}
                    title={
                      isStopping
                        ? "本轮正在停止，消息会进入暂存区"
                        : isStreaming
                          ? "加入暂存区，本轮结束后自动发送"
                          : "发送"
                    }
                    aria-label={isBusy ? "排队发送" : "发送消息"}
                    className="ui-btn ui-btn-sm ui-btn-primary shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Send className="h-3.5 w-3.5" />
                    {isBusy ? "排队" : "发送"}
                  </button>
                  {(isStreaming || isStopping) && (
                    <button
                      onClick={() => {
                        void abort().catch((err) => {
                          toast.error(toMessage(err), 5000);
                        });
                      }}
                      disabled={isStopping}
                      title={
                        isStopping
                          ? "正在等待上一轮收尾"
                          : "停止本轮运行（暂存区会暂停）"
                      }
                      aria-label="停止运行"
                      className="ui-btn ui-btn-sm ui-btn-danger-soft shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Square className="h-3.5 w-3.5" />
                      {isStopping ? "停止中…" : "停止"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
