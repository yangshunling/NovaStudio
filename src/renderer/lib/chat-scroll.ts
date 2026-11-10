/**
 * 聊天区消息定位（问题导航 / 载入更早共用）
 *
 * 为什么不是一次 scrollTo 就够：
 * 1. 消息里可能有图片、代码块、异步渲染的卡片，高度在滚动过程中会变；
 *    单次测量的落点在动画结束后已经失效。
 * 2. assistant-ui 在内容尺寸变化时也会调整滚动位置（跟随底部 / 保持锚点）。
 * 因此这里在滚动结束后重新测量、校正，直到目标位置稳定。
 *
 * 注意：聊天消息区**不能**使用 content-visibility: auto。离屏消息在换回
 * 真实高度前只有 contain-intrinsic-size 的估算值，会让这里测出的 offset
 * 大幅偏离真实位置 —— 这是问题导航「点了到不了」的根因。
 */

/** 滚动容器 id；由 AssistantMessageList 标注 */
export const CHAT_VIEWPORT_ID = "chat-viewport";

/** 跳转后问题与容器顶部保留的呼吸空间 */
const SCROLL_GAP = 16;

/** 校正容差（px）：小于它视为已经对准 */
const SETTLE_TOLERANCE = 1;

/** 校正最多持续多少帧，避免内容持续变化时无限循环 */
const SETTLE_MAX_FRAMES = 30;

const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/**
 * 全局请求序号：点击另一条问题时，旧的校正必须立刻作废，
 * 否则两个校正循环会把滚动位置来回拉扯。
 */
let requestSeq = 0;

export function findChatViewport(): HTMLElement | null {
  return document.getElementById(CHAT_VIEWPORT_ID);
}

export function findMessageElement(
  viewport: HTMLElement,
  id: string,
): HTMLElement | null {
  // CSS.escape：消息 id 来自运行时，不能假设它不含引号等选择器字符
  return viewport.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(id)}"]`,
  );
}

function offsetInViewport(
  viewport: HTMLElement,
  element: HTMLElement,
): number {
  return (
    element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  );
}

/**
 * 滚动到指定消息。
 * 返回 false 表示消息当前未挂载（在窗口化范围之外），调用方应请求展开。
 */
export function scrollToMessage(
  id: string,
  options: { behavior?: ScrollBehavior } = {},
): boolean {
  const viewport = findChatViewport();
  if (!viewport) return false;
  const element = findMessageElement(viewport, id);
  if (!element) return false;

  const token = ++requestSeq;
  const target = Math.max(
    0,
    viewport.scrollTop + offsetInViewport(viewport, element) - SCROLL_GAP,
  );

  viewport.scrollTo({ top: target, behavior: options.behavior ?? "smooth" });
  settle(viewport, id, token);
  return true;
}

/**
 * 等滚动动画结束后做「落点校正」。
 *
 * 不用定时器猜动画时长：优先监听 scrollend；不支持时退化为
 * 「连续几帧 scrollTop 不再变化」判定动画结束。
 * 用户在过程中接管滚动（滚轮 / 触摸 / 方向键）时立刻放弃，不跟手势抢。
 */
function settle(viewport: HTMLElement, id: string, token: number): void {
  /** waiting = 等动画结束；correcting = 正在校正；stopped = 已放弃 */
  let phase: "waiting" | "correcting" | "stopped" = "waiting";
  let frame = 0;
  let detach: () => void = () => {};

  const stop = (): void => {
    if (phase === "stopped") return;
    phase = "stopped";
    cancelAnimationFrame(frame);
    detach();
  };

  const correct = (): void => {
    let frames = 0;
    let stableFrames = 0;

    const step = (): void => {
      if (phase === "stopped") return;
      if (token !== requestSeq) {
        // 已有更新的跳转请求：立刻让位，并摘掉旧监听
        detach();
        return;
      }
      const element = findMessageElement(viewport, id);
      if (!element) {
        detach();
        return;
      }

      const delta = offsetInViewport(viewport, element) - SCROLL_GAP;
      if (Math.abs(delta) <= SETTLE_TOLERANCE) {
        stableFrames += 1;
        if (stableFrames >= 2) {
          detach();
          return;
        }
      } else {
        stableFrames = 0;
        viewport.scrollTop = Math.max(0, viewport.scrollTop + delta);
      }

      if (frames++ < SETTLE_MAX_FRAMES) frame = requestAnimationFrame(step);
      else detach();
    };

    frame = requestAnimationFrame(step);
  };

  const onUserGesture = (event: Event): void => {
    if (
      event.type === "keydown" &&
      !SCROLL_KEYS.has((event as KeyboardEvent).key)
    ) {
      return;
    }
    stop();
  };

  const startCorrecting = (): void => {
    // scrollend 与空转兜底都可能触发，只允许启动一次
    if (phase !== "waiting") return;
    if (token !== requestSeq) {
      phase = "stopped";
      detach();
      return;
    }
    phase = "correcting";
    viewport.removeEventListener("scrollend", startCorrecting);
    correct();
  };

  detach = (): void => {
    viewport.removeEventListener("scrollend", startCorrecting);
    viewport.removeEventListener("wheel", onUserGesture);
    viewport.removeEventListener("touchstart", onUserGesture);
    viewport.removeEventListener("keydown", onUserGesture);
  };

  viewport.addEventListener("scrollend", startCorrecting);
  viewport.addEventListener("wheel", onUserGesture, { passive: true });
  viewport.addEventListener("touchstart", onUserGesture, { passive: true });
  viewport.addEventListener("keydown", onUserGesture);

  /*
   * scrollend 兜底：极少数情况下它不触发（动画被同帧覆盖等）。
   * 只在「已经观察到滚动」之后才按空转判定结束 —— 平滑动画启动前
   * 的头几帧 scrollTop 本来就不变，直接判定会打断动画、变成瞬跳。
   */
  let last = viewport.scrollTop;
  let idleFrames = 0;
  let observedMovement = false;
  let fallbackFrames = 0;
  const fallback = (): void => {
    if (phase !== "waiting") return;
    if (token !== requestSeq) {
      detach();
      return;
    }
    if (observedMovement && idleFrames >= 5) {
      startCorrecting();
      return;
    }
    if (fallbackFrames++ > 120) return; // 最多观察 2 秒
    if (Math.abs(viewport.scrollTop - last) >= 0.5) {
      observedMovement = true;
      idleFrames = 0;
      last = viewport.scrollTop;
    } else if (observedMovement) {
      idleFrames += 1;
    }
    requestAnimationFrame(fallback);
  };
  requestAnimationFrame(fallback);
}
