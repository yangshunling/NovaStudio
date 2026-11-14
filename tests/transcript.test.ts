import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatSessionTranscript,
  transcriptFileName,
} from "../src/main/sessions/transcript.ts";
import type { Message, Session } from "../src/shared/types.ts";

const CREATED = Date.UTC(2026, 0, 2, 3, 4, 5);

function makeSession(messages: Message[]): Session {
  return {
    id: "sess-1",
    projectId: null,
    agentId: "claude",
    agentSessionId: null,
    title: "测试会话",
    cwd: "E:\\proj",
    createdAt: CREATED,
    updatedAt: CREATED + 60_000,
    messages,
  };
}

test("导出会话：覆盖思考、工具、错误与用量，忽略流式增量", () => {
  const messages: Message[] = [
    {
      id: "u1",
      role: "user",
      timestamp: CREATED,
      content: [
        {
          type: "reference",
          kind: "session",
          name: "上次的排查会话",
          detail: "C:/sessions/abc.jsonl",
        },
        { type: "text", content: "帮我看看这个项目" },
        { type: "image", mediaType: "image/png", ref: "att-1" },
      ],
    },
    {
      id: "a1",
      role: "assistant",
      employeeId: "emp-1",
      timestamp: CREATED + 10_000,
      content: [
        { type: "thinking", content: "先看目录结构" },
        { type: "text", content: "我先读取入口文件。" },
        {
          type: "tool_call",
          callId: "c1",
          name: "Read",
          kind: "read",
          target: "src/index.ts",
          input: { file_path: "src/index.ts" },
        },
        {
          type: "tool_result",
          callId: "c1",
          name: "Read",
          output: "console.log('hi')",
        },
        { type: "error", message: "权限不足", fatal: true },
        { type: "warning", message: "输出被截断" },
        {
          type: "usage",
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          costUsd: 0.0012,
        },
        { type: "text_delta", delta: "不应出现的增量文本" },
      ],
    },
    {
      id: "s1",
      role: "system",
      timestamp: CREATED + 20_000,
      content: [{ type: "text", content: "以上为旧对话" }],
    },
  ];

  const markdown = formatSessionTranscript(makeSession(messages), {
    agentName: "Claude Code",
    employeeNames: { "emp-1": "陆行舟" },
  });

  assert.match(markdown, /^# 测试会话/m);
  assert.match(markdown, /- Agent：Claude Code/);
  assert.match(markdown, /- 工作目录：`E:\\proj`/);
  assert.match(markdown, /## 用户 · /);
  assert.match(markdown, /## 助手 · 陆行舟 · /);
  assert.match(markdown, /## 系统 · /);
  assert.match(markdown, /引用会话：上次的排查会话/);
  assert.match(markdown, /C:\/sessions\/abc\.jsonl/);
  assert.match(markdown, /附带 1 张图片/);
  assert.match(markdown, /<summary>思考过程<\/summary>/);
  assert.match(markdown, /工具调用 · `Read`/);
  assert.match(markdown, /操作对象：`src\/index\.ts`/);
  assert.match(markdown, /工具结果 · `Read`/);
  assert.match(markdown, /权限不足/);
  assert.match(markdown, /输出被截断/);
  assert.match(markdown, /用量：输入 10 \/ 输出 20 tokens/);
  assert.doesNotMatch(markdown, /不应出现的增量文本/);
});

test("导出文件名：过滤非法字符并保留可读标题", () => {
  assert.equal(
    transcriptFileName("修复 登录/注册: 问题？"),
    "修复 登录-注册- 问题？.md",
  );
  assert.equal(transcriptFileName("   "), "会话导出.md");
});
