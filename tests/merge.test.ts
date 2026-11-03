import assert from "node:assert/strict";
import { test } from "node:test";
import { appendEvent } from "../src/shared/merge.ts";
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
