/**
 * 用户消息气泡
 *
 * 实时消息列表（AssistantMessageList）和历史消息列表（MessageList）共用，
 * 避免两处各写一份 class 后逐渐漂移。
 */

import type { ReactNode } from "react";

export function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-border-strong bg-bubble-user px-4 py-2.5 text-body-lg text-bubble-user-text shadow-[var(--c-shadow-sm)]">
      {children}
    </div>
  );
}
