/**
 * 问题导航 — 对话区右侧的提问索引
 *
 * 每个用户提问对应一条小刻度：点击滚动到该提问，滚动对话时自动高亮当前问题。
 * 只有 2 个及以上提问时才显示，避免单轮对话多出一条无用的竖栏。
 *
 * 定位依赖 assistant-ui 的 MessagePrimitive.Root 自带 data-message-id，
 * 以及 AssistantMessageList 中给滚动容器标注的 id="chat-viewport"。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { selectCurrentMessages, useChatStore } from "../../stores/chat";
import { firstText } from "../../lib/utils";
import { requestRevealMessage } from "../../lib/chat-events";

/** 跳转后问题与容器顶部保留的呼吸空间 */
const SCROLL_GAP = 16;

/** 判定「已滚过该问题」的阈值 */
const ACTIVE_OFFSET = 24;

/** 滚动容器 id；由 AssistantMessageList 标注 */
const VIEWPORT_ID = "chat-viewport";

export function QuestionNav() {
  const sessionId = useChatStore((s) => s.currentSessionId);
  const messages = useChatStore(selectCurrentMessages);

  const questions = useMemo(
    () =>
      messages
        .filter((message) => message.role === "user")
        .map((message) => ({
          id: message.id,
          text: firstText(message.content).replace(/\s+/g, " ").trim(),
        })),
    [messages],
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  /** 只关心「有哪些问题」，避免流式输出每个 token 都重绑监听 */
  const idsKey = questions.map((question) => question.id).join("|");
  const questionsRef = useRef(questions);
  questionsRef.current = questions;

  // 切换会话 / 提问数量变化时，重新计算当前问题
  useEffect(() => {
    const viewport = document.getElementById(VIEWPORT_ID);
    if (!viewport) return;

    const update = () => {
      const list = questionsRef.current;
      if (list.length === 0) {
        setActiveId(null);
        return;
      }
      const viewportTop = viewport.getBoundingClientRect().top;
      let current = list[0].id;
      for (const question of list) {
        const element = viewport.querySelector<HTMLElement>(
          `[data-message-id="${question.id}"]`,
        );
        if (!element) continue;
        if (element.getBoundingClientRect().top - viewportTop > ACTIVE_OFFSET) {
          break;
        }
        current = question.id;
      }
      setActiveId(current);
    };

    update();

    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    // 历史回放 / 流式追加会让消息节点晚于本次 effect 出现，观察到变化再算一次
    const observer = new MutationObserver(update);
    observer.observe(viewport, { childList: true, subtree: true });

    return () => {
      viewport.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [sessionId, idsKey]);

  // 问题很多时导航自身会滚动：保证当前高亮项始终在可视区内
  useEffect(() => {
    if (!activeId) return;
    railRef.current
      ?.querySelector<HTMLElement>(`[data-question-id="${activeId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  if (questions.length < 2) return null;

  const jumpTo = (id: string) => {
    const viewport = document.getElementById(VIEWPORT_ID);
    if (!viewport) return;
    const element = viewport.querySelector<HTMLElement>(
      `[data-message-id="${id}"]`,
    );
    if (!element) {
      // 消息在窗口之外：请求消息列表展开到该条，展开后会自动滚动
      requestRevealMessage(id);
      return;
    }
    const top =
      element.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top +
      viewport.scrollTop -
      SCROLL_GAP;
    viewport.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    setActiveId(id);
  };

  return (
    <div
      ref={railRef}
      aria-label="问题导航"
      className="ui-scroll-hidden absolute right-2 top-1/2 z-20 flex max-h-full w-6 -translate-y-1/2 flex-col overflow-y-auto"
    >
      {/* m-auto：放得下时垂直居中，提问过多溢出时又能从上往下正常滚动 */}
      <div className="m-auto flex w-full flex-col items-center gap-0.5">
        {questions.map((question, index) => {
          const active = question.id === activeId;
          return (
            <button
              key={question.id}
              type="button"
              data-question-id={question.id}
              onClick={() => jumpTo(question.id)}
              title={question.text || `第 ${index + 1} 个问题`}
              aria-label={`跳转到第 ${index + 1} 个问题`}
              aria-current={active ? "true" : undefined}
              className={`w-full cursor-pointer py-0.5 text-center font-display text-caption italic leading-none tabular-nums transition-colors ${
                active
                  ? "text-accent"
                  : "text-text-muted/60 hover:text-text-secondary"
              }`}
            >
              {String(index + 1).padStart(2, "0")}
            </button>
          );
        })}
      </div>
    </div>
  );
}
