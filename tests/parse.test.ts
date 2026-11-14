import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { appendEvent } from "../src/shared/agent-events.ts";
import type { AgentEvent } from "../src/shared/types.ts";

/**
 * parse.ts 里用的是无扩展名的相对导入（由 Vite 解析），Node 的类型剥离
 * 无法直接加载。这里用项目已依赖的 esbuild 打包成 data URL 再导入，
 * 保证测试跑的是真实源码而不是复制品。
 */
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/main/agents/claude/parse.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const parse = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)) as typeof import("../src/main/agents/claude/parse.ts");

const SESSION = "test-session";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function assistant(content: unknown[], messageId = "m1", parent?: string): string {
  return line({
    type: "assistant",
    session_id: SESSION,
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { id: messageId, role: "assistant", content },
  });
}

function toolResult(toolUseId: string, output = "ok"): string {
  return line({
    type: "user",
    session_id: SESSION,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: output }],
    },
  });
}

function messageStart(): string {
  return line({
    type: "stream_event",
    session_id: SESSION,
    event: { type: "message_start", message: { id: "m1" } },
  });
}

function messageStop(): string {
  return line({
    type: "stream_event",
    session_id: SESSION,
    event: { type: "message_stop" },
  });
}

/** 按解码 → 合并的真实链路累积成一条 assistant 消息的内容 */
function reduce(lines: string[]): AgentEvent[] {
  const decoder = parse.createDecoder();
  let content: AgentEvent[] = [];
  for (const input of lines) {
    const decoded = decoder(input);
    if (!decoded) continue;
    for (const event of Array.isArray(decoded) ? decoded : [decoded]) {
      content = appendEvent(content, event);
    }
  }
  return content;
}

test("工具回执穿插在同一条 assistant 消息中时，不会重复累积块", () => {
  /*
   * 真实流形：Claude Code 在同一个 message.id 下逐块发 assistant 事件，
   * 并且可能在后续块的 assistant 事件到达之前就执行完前面的工具、把
   * tool_result 写进流里（并行工具调用）。修复前，第二个 tool_use 的
   * message_end 会把「整条消息的累积全集」再追加一遍：
   *   T X A rA  T X A B rB
   * 于是 A 出现两次，而只有一份 result —— 界面上那份永远停在“进行中”。
   */
  const content = reduce([
    messageStart(),
    assistant([{ type: "thinking", thinking: "T" }]),
    assistant([{ type: "text", text: "X" }]),
    assistant([{ type: "tool_use", id: "a", name: "Read", input: { path: "a.ts" } }]),
    toolResult("a"),
    assistant([{ type: "tool_use", id: "b", name: "Edit", input: { path: "b.ts" } }]),
    toolResult("b"),
  ]);

  assert.deepEqual(
    content.filter((e) => e.type === "thinking").map((e) => e.content),
    ["T"],
  );
  assert.deepEqual(
    content.filter((e) => e.type === "text").map((e) => e.content),
    ["X"],
  );
  assert.deepEqual(
    content.filter((e) => e.type === "tool_call").map((e) => e.callId),
    ["a", "b"],
  );
  assert.deepEqual(
    content.filter((e) => e.type === "tool_result").map((e) => e.callId),
    ["a", "b"],
  );
});

test("Bash 等命令类工具同样进入消息流，正文既不重复也不丢失", () => {
  // 命令类工具不再被静默：调用（exec 分类）与回执都要出现在消息流里，
  // 且回执作为执行边界会切断累积，前后两段正文仍然完整。
  const content = reduce([
    messageStart(),
    assistant([{ type: "text", text: "X" }]),
    assistant([{ type: "tool_use", id: "bash1", name: "Bash", input: { command: "ls" } }]),
    toolResult("bash1"),
    assistant([{ type: "text", text: "Y" }]),
  ]);

  assert.deepEqual(
    content.filter((e) => e.type === "text").map((e) => e.content),
    ["X", "Y"],
  );

  const calls = content.filter((e) => e.type === "tool_call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callId, "bash1");
  assert.equal(calls[0].kind, "exec");
  assert.equal(calls[0].target, "ls");

  const results = content.filter((e) => e.type === "tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0].callId, "bash1");
  assert.equal(results[0].name, "Bash");
});

test("API 错误 assistant 事件解码成 error，而不是普通正文", () => {
  const decoder = parse.createDecoder();
  const event = decoder(
    line({
      type: "assistant",
      session_id: SESSION,
      isApiErrorMessage: true,
      error: "server_error",
      message: {
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: "API Error: 502 upstream failed" }],
      },
    }),
  );

  assert.deepEqual(event, {
    type: "error",
    message: "API Error: 502 upstream failed",
  });
});

test("API 错误没有正文时用 error 字段兜底", () => {
  const decoder = parse.createDecoder();
  const event = decoder(
    line({
      type: "assistant",
      session_id: SESSION,
      isApiErrorMessage: true,
      error: "unknown",
      message: { id: "m1", role: "assistant", content: [] },
    }),
  );

  assert.deepEqual(event, { type: "error", message: "API 错误（unknown）" });
});

test("tool_result 里的图片块转成 images，文本仍保留", () => {
  const events = parse.mapToolResultBlocks(
    [
      {
        type: "tool_result",
        tool_use_id: "t1",
        is_error: false,
        content: [
          { type: "text", text: "screenshot" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
    ],
    new Map([["t1", "Bash"]]),
  );

  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.type, "tool_result");
  if (event.type !== "tool_result") return;
  assert.equal(event.output, "screenshot");
  assert.deepEqual(event.images, [{ mediaType: "image/png", data: "AAAA" }]);
});

test("system api_error 解码为 error", () => {
  const decoder = parse.createDecoder();
  const event = decoder(
    line({
      type: "system",
      subtype: "api_error",
      error: { message: "401 authentication failed" },
    }),
  );
  assert.deepEqual(event, {
    type: "error",
    message: "401 authentication failed",
  });
});

test("system informational 按 level 解码为 warning", () => {
  const decoder = parse.createDecoder();
  const event = decoder(
    line({
      type: "system",
      subtype: "informational",
      level: "warning",
      content: "Streaming ended, retrying",
    }),
  );
  assert.deepEqual(event, {
    type: "warning",
    message: "Streaming ended, retrying",
  });
});

test("同一段内的增量仍由 message_end 收敛，不产生重复", () => {
  const content = reduce([
    messageStart(),
    line({
      type: "stream_event",
      session_id: SESSION,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "你" },
      },
    }),
    assistant([{ type: "text", text: "你好" }]),
    messageStop(),
  ]);

  assert.deepEqual(
    content.filter((e) => e.type === "text").map((e) => e.content),
    ["你好"],
  );
});

test("result 行解析出本轮 token 用量与上下文窗口", () => {
  const decoder = parse.createDecoder();
  const event = decoder(
    line({
      type: "result",
      subtype: "success",
      session_id: SESSION,
      usage: {
        input_tokens: 1200,
        output_tokens: 345,
        cache_creation_input_tokens: 60,
        cache_read_input_tokens: 7890,
      },
      modelUsage: {
        "claude-sonnet-4-5": { contextWindow: 200_000 },
      },
      total_cost_usd: 0.0123,
      duration_ms: 4567,
    }),
  );

  assert.deepEqual(event, {
    type: "usage",
    inputTokens: 1200,
    outputTokens: 345,
    cacheCreationInputTokens: 60,
    cacheReadInputTokens: 7890,
    contextWindow: 200_000,
    costUsd: 0.0123,
    durationMs: 4567,
  });
});

test("message_start 解析出单次 API 调用的上下文快照", () => {
  const decoder = parse.createDecoder();
  const event = decoder(
    line({
      type: "stream_event",
      session_id: SESSION,
      event: {
        type: "message_start",
        message: {
          id: "m1",
          usage: {
            input_tokens: 11,
            cache_creation_input_tokens: 22,
            cache_read_input_tokens: 33,
            output_tokens: 1,
          },
        },
      },
    }),
  );

  assert.deepEqual(event, {
    type: "usage",
    scope: "context",
    inputTokens: 11,
    outputTokens: 1,
    cacheCreationInputTokens: 22,
    cacheReadInputTokens: 33,
  });
});

test("assistant 消息解析出单次 API 调用的上下文快照", () => {
  const decoder = parse.createDecoder();
  const event = decoder(
    line({
      type: "assistant",
      session_id: SESSION,
      message: {
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 34,
          cache_read_input_tokens: 56,
          output_tokens: 7,
        },
      },
    }),
  );

  assert.ok(Array.isArray(event));
  assert.equal(event[0]?.type, "text");
  assert.deepEqual(event[1], {
    type: "usage",
    scope: "context",
    inputTokens: 12,
    outputTokens: 7,
    cacheCreationInputTokens: 34,
    cacheReadInputTokens: 56,
  });
});

test("失败的 result 同时上报 error 与 usage", () => {
  const decoder = parse.createDecoder();
  const events = decoder(
    line({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      usage: { input_tokens: 10, output_tokens: 20 },
      errors: ["No conversation found"],
    }),
  );

  assert.ok(Array.isArray(events));
  assert.deepEqual(events[0], {
    type: "error",
    message: "No conversation found",
    // result 行错误是终态：宿主据此判定本轮失败（即使有部分正文）
    fatal: true,
  });
  assert.equal(events[1]?.type, "usage");
});

test("缺少 usage 的 result 不产生用量事件", () => {
  const decoder = parse.createDecoder();
  const event = decoder(
    line({ type: "result", subtype: "success", session_id: SESSION }),
  );
  assert.equal(event, null);
});
