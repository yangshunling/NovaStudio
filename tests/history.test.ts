import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Message } from "../src/shared/types.ts";

/**
 * readHistory 读的是 <configDir>/projects/<cwd 转义>/<sessionId>.jsonl。
 * 这里用临时 configDir 造一份真实形态的会话文件，验证回放层对这些记录的处理。
 */
const bundled = await build({
  entryPoints: [
    fileURLToPath(new URL("../src/main/agents/claude/sessions.ts", import.meta.url)),
  ],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const sessions = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)) as typeof import("../src/main/agents/claude/sessions.ts");

const CWD = "C:\\fake\\proj";
const SESSION_ID = "sess-1";

/** 造一份会话文件并回放；返回解析后的消息列表 */
async function replay(records: unknown[]): Promise<Message[]> {
  const configDir = mkdtempSync(join(tmpdir(), "nova-history-"));
  try {
    // encodeCwd：\ / : 全部替换为 -
    const dir = join(configDir, "projects", "C--fake-proj");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"), "utf8");
    return await sessions.readHistory(SESSION_ID, CWD, configDir);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

function userMessage(
  content: unknown,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    type: "user",
    uuid: `u-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    ...extra,
    message: { role: "user", content },
  };
}

function assistantMessage(
  content: unknown[],
  extra: Record<string, unknown> = {},
): unknown {
  return {
    type: "assistant",
    uuid: `a-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    ...extra,
    message: { id: "m1", role: "assistant", content },
  };
}

test("history: isMeta 与 isCompactSummary 不当作用户发言", async () => {
  const messages = await replay([
    userMessage("hello"),
    userMessage("<local-command-caveat>ignore me</local-command-caveat>", {
      isMeta: true,
    }),
    userMessage("compacted summary", { isCompactSummary: true }),
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.deepEqual(messages[0].content, [{ type: "text", content: "hello" }]);
});

test("history: user 数组里的 text 块（中断标记）不再丢失", async () => {
  const messages = await replay([
    userMessage([{ type: "text", text: "[Request interrupted by user]" }]),
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.deepEqual(messages[0].content, [
    { type: "text", content: "[Request interrupted by user]" },
  ]);
});

test("history: API 错误记录渲染成 error 事件，而不是普通正文", async () => {
  const messages = await replay([
    assistantMessage(
      [{ type: "text", text: "API Error: 502 upstream failed" }],
      { isApiErrorMessage: true, error: "server_error" },
    ),
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.deepEqual(messages[0].content, [
    { type: "error", message: "API Error: 502 upstream failed" },
  ]);
});

test("history: system api_error 与 informational 进入历史", async () => {
  const messages = await replay([
    assistantMessage([{ type: "text", text: "before" }]),
    {
      type: "system",
      subtype: "api_error",
      uuid: "s1",
      timestamp: new Date().toISOString(),
      error: { message: "401 authentication failed" },
    },
    {
      type: "system",
      subtype: "informational",
      level: "warning",
      content: "Streaming ended, retrying",
      uuid: "s2",
      timestamp: new Date().toISOString(),
    },
  ]);

  assert.equal(messages.length, 1);
  const events = messages[0].content;
  assert.deepEqual(
    events.filter((e) => e.type === "error"),
    [{ type: "error", message: "401 authentication failed" }],
  );
  assert.deepEqual(
    events.filter((e) => e.type === "warning"),
    [{ type: "warning", message: "Streaming ended, retrying" }],
  );
});

test("history: 工具回执里的图片被保留", async () => {
  const messages = await replay([
    assistantMessage([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "screenshot" } },
    ]),
    userMessage([
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
    ]),
  ]);

  const results = messages.flatMap((m) =>
    m.content.filter((e) => e.type === "tool_result"),
  );
  assert.equal(results.length, 1);
  const [result] = results;
  if (result.type !== "tool_result") return;
  assert.deepEqual(result.images, [{ mediaType: "image/png", data: "AAAA" }]);
});

test("history: 工具回执仍追加到上一条 assistant 消息", async () => {
  const messages = await replay([
    assistantMessage([
      {
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: { path: "a.ts" },
      },
    ]),
    userMessage([
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "file body",
        is_error: false,
      },
    ]),
  ]);

  assert.equal(messages.length, 1);
  const events = messages[0].content;
  assert.equal(events.filter((e) => e.type === "tool_call").length, 1);
  assert.equal(events.filter((e) => e.type === "tool_result").length, 1);
});
