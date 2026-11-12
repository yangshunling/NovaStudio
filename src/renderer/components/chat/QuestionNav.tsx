/**
 * 问题导航 — 对话区右侧的提问索引
 *
 * 每个用户提问对应一条小刻度：点击滚动到该提问，滚动对话时自动高亮当前问题。
 * 竖栏上下各有一个箭头：回到会话开头 / 滚动到最新消息。
 * 只有 2 个及以上提问时才显示，避免单轮对话多出一条无用的竖栏。
 *
 * 定位依赖 assistant-ui 的 MessagePrimitive.Root 自带 data-message-id，
 * 以及 AssistantMessageList 中给滚动容器标注的 id="chat-viewport"。
 */

import { useEffect, useRef, useState } from "react";
import { ChevronsDown, ChevronsUp } from "lucide-react";
import { selectCurrentMessages, useChatStore } from "../../stores/chat";
import { firstText } from "../../lib/utils";
import { requestRevealMessage } from "../../lib/chat-events";
import {
  findChatViewport,
  findMessageElement,
  scrollToMessage,
} from "../../lib/chat-scroll";

/**
 * 置顶 / 到底部箭头：浅色圆片 + 细描边，hover 浮起并染 accent，
 * 到达边缘时褪成透明（disabled:pointer-events-none 保证不挡消息点击）。
 * 方向位移由上/下箭头各自追加。
 */
const ARROW_CLASS =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-surface/85 text-text-muted shadow-[var(--c-shadow-sm)] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out hover:border-accent/40 hover:bg-accent-soft hover:text-accent active:scale-90 disabled:pointer-events-none disabled:border-transparent disabled:bg-transparent disabled:text-text-muted/25 disabled:shadow-none";

export function QuestionNav() {
  const sessionId = useChatStore((s) => s.currentSessionId);
  const messages = useChatStore(selectCurrentMessages);

  /*
   * 流式期间 messages 每个 48ms 批次都会换引用，但用户问题本身不变。
   * 用「用户消息数量 + 最后一条用户消息 id / 块数」作为签名，只在真正新增
   * 或替换用户消息时重建问题列表，避免每次 token 都跑一遍 firstText。
   */
  let userCount = 0;
  let lastUserId = "";
  let lastUserBlocks = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    userCount += 1;
    lastUserId = message.id;
    lastUserBlocks = message.content.length;
  }
  const questionsKey = `${userCount}\u0000${lastUserId}\u0000${lastUserBlocks}`;
  const questionsCache = useRef<{
    key: string;
    questions: Array<{ id: string; text: string }>;
  }>({ key: "", questions: [] });
  if (questionsCache.current.key !== questionsKey) {
    questionsCache.current = {
      key: questionsKey,
      questions: messages
        .filter((message) => message.role === "user")
        .map((message) => ({
          id: message.id,
          text: firstText(message.content).replace(/\s+/g, " ").trim(),
        })),
    };
  }
  const questions = questionsCache.current.questions;

  const [activeId, setActiveId] = useState<string | null>(null);
  /** 是否已贴顶 / 贴底：到达边缘时把对应箭头置灰，避免无效点击 */
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  /** 只关心「有哪些问题」，避免流式输出每个 token 都重绑监听 */
  const idsKey = questions.map((question) => question.id).join("|");
  const questionsRef = useRef(questions);
  questionsRef.current = questions;
  /** 会话首条消息：用于判断「真的在开头」还是只是滚动窗口的顶部 */
  const firstMessageIdRef = useRef<string | null>(null);
  firstMessageIdRef.current = messages[0]?.id ?? null;

  // 切换会话 / 提问数量变化时，重新计算当前问题
  useEffect(() => {
    const viewport = findChatViewport();
    if (!viewport) return;

    const update = () => {
      // 边缘状态与问题数量无关：只有一轮提问的长会话也需要上下箭头。
      // 「顶部」不能只看 scrollTop：消息列表是窗口化的，窗口顶部之上
      // 可能还有未挂载的更早消息，此时首条消息不在 DOM 里，箭头仍要可用。
      const firstId = firstMessageIdRef.current;
      setAtTop(
        viewport.scrollTop <= 1 &&
          (!firstId || !!findMessageElement(viewport, firstId)),
      );
      setAtBottom(
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1,
      );

      const list = questionsRef.current;
      if (list.length === 0) {
        setActiveId(null);
        return;
      }
      const viewportTop = viewport.getBoundingClientRect().top;
      const viewportBottom = viewportTop + viewport.clientHeight;
      /*
       * 高亮规则：取「已经进入过视口」的最后一个提问。
       *
       * 不能只认「顶边已越过视口顶部」的提问 —— 那样提问停在屏幕中间
       * 甚至下方时，导航仍停在上一题，用户明明看到了第 7 个问题，
       * 侧栏却还高亮第 6 个。这里只要提问的顶边越过视口底边，就归到它，
       * 与其后的回答一起算作「当前问题」。
       *
       * 消息列表是窗口化的：较新的消息才挂载，未挂载的一定在窗口之前，
       * 也就是全部位于视口上方。因此遇到缺失元素时不能跳过 ——
       * 它正是「当前视口上方最近的问题」的候选，否则滚到窗口顶部时
       * 会错误地高亮第 1 个问题。
       */
      let current = list[0].id;
      for (const question of list) {
        const element = findMessageElement(viewport, question.id);
        if (!element) {
          current = question.id;
          continue;
        }
        // 还没进入视口（在屏幕下方）：后面的更靠下，不必再看
        if (element.getBoundingClientRect().top >= viewportBottom) break;
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
    // 消息在窗口之外时返回 false：请求消息列表展开到该条，展开后会自动滚动
    if (!scrollToMessage(id)) {
      requestRevealMessage(id);
      return;
    }
    setActiveId(id);
  };

  /**
   * 置顶：滚到会话的第一条消息。
   * 消息列表是窗口化的，首条可能尚未挂载 —— 此时请求展开到它，
   * 展开后 AssistantMessageList 会自动完成滚动。
   */
  const jumpToTop = () => {
    const first = messages[0];
    if (!first) return;
    if (!scrollToMessage(first.id, { behavior: "smooth" })) {
      requestRevealMessage(first.id);
      return;
    }
    setActiveId(questions[0]?.id ?? null);
  };

  /** 到底部：最新消息一定在挂载窗口内，直接滚到容器底部即可 */
  const jumpToBottom = () => {
    const viewport = findChatViewport();
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  };

  return (
    <div
      aria-label="问题导航"
      className="absolute right-2 top-1/2 z-20 flex max-h-full w-7 -translate-y-1/2 flex-col items-center gap-1"
    >
      <button
        type="button"
        title="回到会话开头"
        aria-label="回到会话开头"
        disabled={atTop}
        onClick={jumpToTop}
        className={`${ARROW_CLASS} hover:-translate-y-px`}
      >
        <ChevronsUp className="h-3.5 w-3.5" strokeWidth={2.5} />
      </button>

      {/* 提问很多时只让中间索引滚动，上下箭头始终固定 */}
      <div
        ref={railRef}
        className="ui-scroll-hidden min-h-0 w-full flex-1 overflow-y-auto"
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
                className={`w-full cursor-pointer py-0.5 text-center ui-type-body font-semibold italic leading-none tabular-nums transition-colors ${
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

      <button
        type="button"
        title="滚动到最新消息"
        aria-label="滚动到最新消息"
        disabled={atBottom}
        onClick={jumpToBottom}
        className={`${ARROW_CLASS} hover:translate-y-px`}
      >
        <ChevronsDown className="h-3.5 w-3.5" strokeWidth={2.5} />
      </button>
    </div>
  );
}
