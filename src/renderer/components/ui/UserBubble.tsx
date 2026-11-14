/**
 * 用户消息气泡
 *
 * 实时消息列表（AssistantMessageList）和历史消息列表（MessageList）共用，
 * 避免两处各写一份 class 后逐渐漂移。
 */

import type { ReactNode } from "react";

export function UserBubble({ children }: { children: ReactNode }) {
  /*
   * 输入框是 textarea，换行与连续空格都原样保留；这里必须显式声明
   * whitespace-pre-wrap，否则 HTML 默认的 white-space: normal 会把
   * 换行折叠成空格、整段消息挤成一行。break-words 兜住超长无空格串。
   */
  return (
    <div className="ui-bubble-user max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-bubble-user px-4 py-2.5 ui-type-item text-bubble-user-text shadow-[var(--c-bubble-shadow)]">
      {children}
    </div>
  );
}
