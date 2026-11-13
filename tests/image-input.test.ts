import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Claude Code 的 stdin 编码：无图走原始正文，有图走 stream-json 用户消息。
 * 打包真实源码，避免测一份手抄的实现。
 */
const bundled = await build({
  entryPoints: [
    fileURLToPath(new URL("../src/main/agents/claude/input.ts", import.meta.url)),
  ],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const input = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)) as typeof import("../src/main/agents/claude/input.ts");

const IMAGE = { mediaType: "image/png", data: "aGVsbG8=" };

test("image input: 无图片时保持纯文本 stdin", () => {
  assert.equal(input.usesStreamJsonInput(), false);
  assert.equal(input.usesStreamJsonInput([]), false);
  assert.equal(input.buildUserInput("你好"), "你好");
  assert.equal(input.buildUserInput("你好", []), "你好");
});

test("image input: 有图片时生成单行 NDJSON 用户消息", () => {
  assert.equal(input.usesStreamJsonInput([IMAGE]), true);

  const raw = input.buildUserInput("这是什么", [IMAGE]);
  assert.ok(raw.endsWith("\n"));
  assert.equal(raw.trim().split("\n").length, 1, "必须是单行 NDJSON");

  assert.deepEqual(JSON.parse(raw), {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "aGVsbG8=",
          },
        },
        { type: "text", text: "这是什么" },
      ],
    },
  });
});

test("image input: 纯图片消息不产生空 text 块", () => {
  const parsed = JSON.parse(input.buildUserInput("", [IMAGE]));
  assert.deepEqual(
    parsed.message.content.map((block: { type: string }) => block.type),
    ["image"],
  );
});

test("image input: 跳过没有数据的图片", () => {
  const parsed = JSON.parse(
    input.buildUserInput("看图", [
      { mediaType: "image/png", data: "" },
      IMAGE,
    ]),
  );
  assert.equal(parsed.message.content.length, 2);
  assert.equal(parsed.message.content[0].source.data, "aGVsbG8=");
});
