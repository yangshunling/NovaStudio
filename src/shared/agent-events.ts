/**
 * 事件流合并
 *
 * 这里只实现**事件模型本身的语义**，不包含任何具体 Agent 的知识：
 *
 * - `text_delta` / `thinking_delta`（增量）：追加到末尾同类型块；
 *   末尾不是同类型则新建块。打字机效果的来源。
 *
 * - `text` / `thinking`（完整块）：始终作为新块追加。
 *   理由：「增量」与「完整块」是两种不同的输出承诺 —— provider 若能提供增量
 *   就应发 delta；只发完整块时，每次输出是一个独立段落，替换末尾会丢内容。
 *
 * - `message_end`（整轮权威块）：倒序移除末尾连续的累积块
 *   （thinking / text / tool_call），换成本次给出的 blocks。
 *   供能提供"本轮最终正确内容"的 provider 做收敛，避免重复内容残留。
 *
 * - 其它事件（tool_call / tool_result / error）：直接追加。
 *
 * 谁发什么事件由各 provider 的解析层决定（src/main/agents/<id>/parse.ts），
 * 因此本文件无需为任何 Agent 开特例分支。
 */

import type { AgentEvent } from "./types";

/** 累积块的类型：message_end 收敛时会被整段替换 */
function isAccumulatedBlock(event: AgentEvent): boolean {
  return (
    event.type === "thinking" || event.type === "text" || event.type === "tool_call"
  );
}

/**
 * 旁路事件：不参与正文，但不能打断 message_end 的收敛扫描。
 *
 * `usage` 是纯元数据（上下文快照 / 本轮用量），渲染层会把它过滤掉；
 * 它却会被追加进 content。若扫描碰到它就停下，前一次 message_end 写入的
 * 累积块就留在原地，本次 message_end 再把它们整段追加一遍 —— 正文重复。
 */
function isTransparentEvent(event: AgentEvent): boolean {
  return event.type === "usage";
}

export function appendEvent(content: AgentEvent[], event: AgentEvent): AgentEvent[] {
  // 整轮权威块：替换末尾连续的累积块，保留更早的块与 tool_result / error
  if (event.type === "message_end") {
    // 尾部可能夹着 usage：先摘出来，替换完累积块再原样放回末尾
    const passthrough: AgentEvent[] = [];
    let start = content.length;
    while (start > 0) {
      const prev = content[start - 1];
      if (isAccumulatedBlock(prev)) {
        start--;
        continue;
      }
      if (isTransparentEvent(prev)) {
        passthrough.unshift(prev);
        start--;
        continue;
      }
      break;
    }
    return [...content.slice(0, start), ...event.blocks, ...passthrough];
  }

  // 增量：追加到当前进行中的同类型块
  if (event.type === "text_delta" || event.type === "thinking_delta") {
    const blockType = event.type === "text_delta" ? "text" : "thinking";
    const last = content[content.length - 1];
    if (last && last.type === blockType && "content" in last) {
      return [
        ...content.slice(0, -1),
        { type: blockType, content: last.content + event.delta } as AgentEvent,
      ];
    }
    return [...content, { type: blockType, content: event.delta } as AgentEvent];
  }

  // 完整块与其它事件：追加
  return [...content, event];
}
