import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * 只测候选地址生成：模型列表请求本身要访问网络，不适合放进单测。
 * 这段逻辑决定「Base URL 怎么填入才能命中模型列表」，写错会让用户
 * 以为配置有问题（404），因此把各种粘贴方式都固定下来。
 */
const bundled = await build({
  entryPoints: [
    fileURLToPath(new URL("../src/main/agents/claude/models.ts", import.meta.url)),
  ],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const models = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)) as typeof import("../src/main/agents/claude/models.ts");

test("根地址：先试 /v1/models，再兜底 /models", () => {
  assert.deepEqual(models.modelsUrlCandidates("https://api.anthropic.com"), [
    "https://api.anthropic.com/v1/models?limit=1000",
    "https://api.anthropic.com/models?limit=1000",
  ]);
});

test("已带 /v1：不重复拼", () => {
  assert.deepEqual(models.modelsUrlCandidates("https://gw.example.com/v1"), [
    "https://gw.example.com/v1/models?limit=1000",
  ]);
});

test("误粘贴完整接口地址：还原成根路径", () => {
  assert.deepEqual(
    models.modelsUrlCandidates("https://api.anthropic.com/v1/messages"),
    [
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://api.anthropic.com/models?limit=1000",
    ],
  );
  // 结尾斜杠也要能识别
  assert.deepEqual(
    models.modelsUrlCandidates("https://api.anthropic.com/v1/messages/"),
    [
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://api.anthropic.com/models?limit=1000",
    ],
  );
});

test("保留网关路径前缀，只去掉接口后缀", () => {
  assert.deepEqual(
    models.modelsUrlCandidates("https://gw.example.com/proxy/v1/messages"),
    [
      "https://gw.example.com/proxy/v1/models?limit=1000",
      "https://gw.example.com/proxy/models?limit=1000",
    ],
  );
});

test("Anthropic 兼容子路径：回退到厂商根路径的模型列表", () => {
  // DeepSeek 的 Anthropic 兼容入口只代理 /v1/messages，
  // 模型列表在根路径的 OpenAI 兼容接口上。
  assert.deepEqual(
    models.modelsUrlCandidates("https://api.deepseek.com/anthropic"),
    [
      "https://api.deepseek.com/anthropic/v1/models?limit=1000",
      "https://api.deepseek.com/anthropic/models?limit=1000",
      "https://api.deepseek.com/v1/models?limit=1000",
      "https://api.deepseek.com/models?limit=1000",
    ],
  );
});

test("空 Base URL 使用官方端点", () => {
  assert.deepEqual(models.modelsUrlCandidates(""), [
    "https://api.anthropic.com/v1/models?limit=1000",
    "https://api.anthropic.com/models?limit=1000",
  ]);
});

test("忽略查询串与锚点", () => {
  assert.deepEqual(
    models.modelsUrlCandidates("https://gw.example.com/v1/messages?beta=1#x"),
    [
      "https://gw.example.com/v1/models?limit=1000",
      "https://gw.example.com/models?limit=1000",
    ],
  );
});

test("非 http(s) 地址直接拒绝", () => {
  assert.throws(() => models.modelsUrlCandidates("ftp://gw.example.com"));
});
