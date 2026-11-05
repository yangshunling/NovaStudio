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

/** 按解码 → 合并的真实链路累积成一条 assistant 消息的内容 */
function reduce(lines: string[], includeSilentTools = false): AgentEvent[] {
  const decoder = parse.createDecoder(includeSilentTools);
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

test("静默工具的回执不展示，但正文既不重复也不丢失", () => {
  // Bash 在聊天模式下不展示，消息流里没有可见的边界事件；
  // 此时继续累积、由 message_end 收敛，前后两段正文都能保留。
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
  assert.equal(content.filter((e) => e.type === "tool_call").length, 0);
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
  ]);

  assert.deepEqual(
    content.filter((e) => e.type === "text").map((e) => e.content),
    ["你好"],
  );
});
