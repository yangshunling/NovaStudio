import assert from "node:assert/strict";
import { test } from "node:test";
import { appendEvent } from "../src/shared/agent-events.ts";
import type { AgentEvent } from "../src/shared/types.ts";

test("text_delta 追加到末尾同类型块", () => {
  let content: AgentEvent[] = [];
  content = appendEvent(content, { type: "text_delta", delta: "你" });
  content = appendEvent(content, { type: "text_delta", delta: "好" });
  assert.deepEqual(content, [{ type: "text", content: "你好" }]);
});

test("thinking 与 text 增量不会互相覆盖", () => {
  let content: AgentEvent[] = [];
  content = appendEvent(content, { type: "thinking_delta", delta: "想" });
  content = appendEvent(content, { type: "text_delta", delta: "答" });
  content = appendEvent(content, { type: "thinking_delta", delta: "法" });
  assert.deepEqual(content, [
    { type: "thinking", content: "想" },
    { type: "text", content: "答" },
    { type: "thinking", content: "法" },
  ]);
});

test("message_end 替换末尾累积块，保留工具结果", () => {
  let content: AgentEvent[] = [];
  content = appendEvent(content, { type: "text_delta", delta: "草稿" });
  content = appendEvent(content, {
    type: "tool_call",
    callId: "t1",
    name: "Read",
    input: {},
    kind: "read",
    target: "a.ts",
  });
  content = appendEvent(content, {
    type: "tool_result",
    callId: "t1",
    name: "Read",
    output: "ok",
  });
  content = appendEvent(content, { type: "text_delta", delta: "中间" });
  content = appendEvent(content, {
    type: "message_end",
    blocks: [{ type: "text", content: "最终正文" }],
  });

  assert.deepEqual(content, [
    // 早于工具调用的段落不在“末尾连续累积块”范围内，会保留
    { type: "text", content: "草稿" },
    {
      type: "tool_call",
      callId: "t1",
      name: "Read",
      input: {},
      kind: "read",
      target: "a.ts",
    },
    { type: "tool_result", callId: "t1", name: "Read", output: "ok" },
    { type: "text", content: "最终正文" },
  ]);
});

test("完整 text 块始终新建段落", () => {
  let content: AgentEvent[] = [];
  content = appendEvent(content, { type: "text", content: "第一段" });
  content = appendEvent(content, { type: "text", content: "第二段" });
  assert.equal(content.length, 2);
});

test("message_end 之间的 usage 元数据不会打断收敛（正文不重复）", () => {
  let content: AgentEvent[] = [];
  const usage: AgentEvent = {
    type: "usage",
    inputTokens: 120,
    outputTokens: 30,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    scope: "context",
    contextWindow: 200000,
  };

  // 同一条消息先到正文块，再到 tool_call 块；两次 message_end 之间夹着一次 usage
  content = appendEvent(content, {
    type: "message_end",
    blocks: [{ type: "text", content: "先说明一下" }],
  });
  content = appendEvent(content, usage);
  content = appendEvent(content, {
    type: "message_end",
    blocks: [
      { type: "text", content: "先说明一下" },
      {
        type: "tool_call",
        callId: "t1",
        name: "Read",
        input: {},
        kind: "read",
        target: "a.ts",
      },
    ],
  });

  assert.deepEqual(
    content.filter((event) => event.type === "text"),
    [{ type: "text", content: "先说明一下" }],
  );
  // usage 仍然保留（用量统计要用），只是不再挡在累积块后面
  assert.equal(content.filter((event) => event.type === "usage").length, 1);
});
