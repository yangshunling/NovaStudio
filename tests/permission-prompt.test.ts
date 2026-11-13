import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * 工具授权协议：控制帧解析、stdin 编码与 control_response 形状。
 * 用 esbuild 打包真实源码，避免测一份手抄实现。
 */
async function loadModule<T>(relative: string): Promise<T> {
  const bundled = await build({
    entryPoints: [
      fileURLToPath(new URL(`../src/main/agents/claude/${relative}`, import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  return (await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  )) as T;
}

const parse = await loadModule<typeof import("../src/main/agents/claude/parse.ts")>(
  "parse.ts",
);
const input = await loadModule<typeof import("../src/main/agents/claude/input.ts")>(
  "input.ts",
);
const permission = await loadModule<
  typeof import("../src/main/agents/claude/permission.ts")
>("permission.ts");
const shared = await import("../src/shared/permission.ts");

const SESSION = "test-session";

function controlRequest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Write",
      display_name: "Write",
      input: { file_path: "C:/tmp/a.txt", content: "hi" },
      description: "C:/tmp/a.txt",
      permission_suggestions: [
        { type: "setMode", mode: "acceptEdits", destination: "session" },
        { not_a_suggestion: true },
      ],
      decision_reason: "Path is outside allowed working directories",
      decision_reason_type: "workingDir",
      tool_use_id: "call-1",
      ...overrides,
    },
  });
}

test("permission: can_use_tool 归一化为权限请求", () => {
  const decode = parse.createStreamDecoder();
  const out = decode(controlRequest());
  assert.equal(out?.sessionId, null);
  assert.equal(out?.event, null);
  assert.equal(out?.control?.type, "permission_request");
  if (out?.control?.type !== "permission_request") return;

  const request = out.control.request;
  assert.equal(request.requestId, "req-1");
  assert.equal(request.toolName, "Write");
  assert.equal(request.displayName, "Write");
  assert.equal(request.description, "C:/tmp/a.txt");
  assert.deepEqual(request.input, { file_path: "C:/tmp/a.txt", content: "hi" });
  assert.equal(
    request.decisionReason,
    "Path is outside allowed working directories",
  );
  assert.equal(request.toolUseId, "call-1");
  // 非对象 / 缺 type 的建议被过滤掉
  assert.equal(request.permissionSuggestions.length, 1);
  assert.equal(request.permissionSuggestions[0].type, "setMode");
});

test("permission: 缺 request_id / tool_name 时忽略该控制帧", () => {
  const decode = parse.createStreamDecoder();
  assert.equal(decode(controlRequest({ tool_name: "" }))?.control, undefined);
  const noId = JSON.stringify({
    type: "control_request",
    request_id: "",
    request: { subtype: "can_use_tool", tool_name: "Write" },
  });
  assert.equal(decode(noId)?.control, undefined);
});

test("permission: control_cancel_request 归一化为取消", () => {
  const decode = parse.createStreamDecoder();
  const out = decode(
    JSON.stringify({ type: "control_cancel_request", request_id: "req-9" }),
  );
  assert.deepEqual(out?.control, {
    type: "permission_cancel",
    requestId: "req-9",
  });
});

test("permission: result 行标记 closeInput，且事件解码不受影响", () => {
  const decode = parse.createStreamDecoder();
  const out = decode(
    JSON.stringify({ type: "result", subtype: "success", session_id: SESSION }),
  );
  assert.equal(out?.sessionId, SESSION);
  assert.equal(out?.closeInput, true);
  assert.equal(out?.control, undefined);
});

test("permission: stream-json 输入在无图片时也输出 NDJSON", () => {
  assert.equal(input.usesStreamJsonInput(undefined, true), true);
  const raw = input.buildUserInput("你好", undefined, true);
  assert.ok(raw.endsWith("\n"));
  assert.equal(raw.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(raw), {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "你好" }] },
  });
  // 旧路径保持不变
  assert.equal(input.buildUserInput("你好"), "你好");
});

test("permission: 只有可能 ask 的模式开启交互", () => {
  assert.equal(shared.modeMayAsk("default"), true);
  assert.equal(shared.modeMayAsk("manual"), true);
  assert.equal(shared.modeMayAsk("auto"), true);
  assert.equal(shared.modeMayAsk("acceptEdits"), true);
  assert.equal(shared.modeMayAsk("plan"), false);
  assert.equal(shared.modeMayAsk("dontAsk"), false);
  assert.equal(shared.modeMayAsk("bypassPermissions"), false);
  assert.equal(shared.modeMayAsk("something-new"), false);
});

test("permission: control_response 的 request_id 位于 response 内部", () => {
  const raw = permission.encodeControlResponse("req-1", {
    behavior: "allow",
    updatedInput: { file_path: "C:/tmp/a.txt" },
  });
  assert.deepEqual(JSON.parse(raw), {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "req-1",
      response: {
        behavior: "allow",
        updatedInput: { file_path: "C:/tmp/a.txt" },
      },
    },
  });
});
