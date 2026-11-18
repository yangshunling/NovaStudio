import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SESSION_TITLE_MAX_CHARS,
  SESSION_TITLE_SCHEMA,
  buildSessionTitlePrompt,
  condenseSessionTitle,
  extractStructuredTitle,
  normalizeSessionTitle,
} from "../src/shared/session-title.ts";

test("结构化输出：直接取 title 字段", () => {
  assert.equal(
    normalizeSessionTitle(
      extractStructuredTitle('{"title":"新建会话默认工作区"}'),
    ),
    "新建会话默认工作区",
  );
});

test("结构化输出：provider 不支持 schema 时回退纯文本", () => {
  assert.equal(
    normalizeSessionTitle(extractStructuredTitle("标题：优化会话标题")),
    "优化会话标题",
  );
});

test("schema 强制 title 字段为必填", () => {
  assert.ok(SESSION_TITLE_SCHEMA.required.includes("title"));
  assert.equal(SESSION_TITLE_SCHEMA.additionalProperties, false);
});

test("模型输出：去掉标题前缀、引号与尾部标点", () => {
  assert.equal(
    normalizeSessionTitle("标题：“新建会话默认工作区”。"),
    "新建会话默认工作区",
  );
});

test("模型输出：多行时只取第一条有效内容", () => {
  assert.equal(
    normalizeSessionTitle("```\n新建会话默认工作区\n```\n说明：以上是标题"),
    "新建会话默认工作区",
  );
});

test("模型输出：空内容返回空串，由调用方保留临时标题", () => {
  assert.equal(normalizeSessionTitle("   \n```\n```"), "");
});

test("模型寒暄：按「标题的内容：」标签取引号内的标题", () => {
  assert.equal(
    normalizeSessionTitle(
      "你好，以下是标题的内容：「新建会话默认工作区」。如果你想调整可以告诉我。",
    ),
    "新建会话默认工作区",
  );
});

test("模型寒暄：没有引号时按标签边界与句号截断", () => {
  assert.equal(
    normalizeSessionTitle(
      "好的，以下是标题：新建会话默认工作区。如果需要更短可以再改。",
    ),
    "新建会话默认工作区",
  );
});

test("模型寒暄：先客套再另起一段给标签", () => {
  assert.equal(
    normalizeSessionTitle(
      "当然可以。\n\n标题：「会话标题自动总结」\n\n理由是首条消息通常包含任务意图。",
    ),
    "会话标题自动总结",
  );
});

test("模型寒暄：标签与标题分成两行", () => {
  assert.equal(
    normalizeSessionTitle(
      "这里是为你生成的标题：\n新建会话默认工作区\n如需修改请告诉我。",
    ),
    "新建会话默认工作区",
  );
});

test("模型寒暄：无冒号的「标题是」也能识别", () => {
  assert.equal(
    normalizeSessionTitle(
      "为你生成的标题是“会话标题自动总结”，希望有帮助！",
    ),
    "会话标题自动总结",
  );
});

test("标题本身以「会话标题」开头时不被误删", () => {
  assert.equal(
    normalizeSessionTitle("会话标题自动总结"),
    "会话标题自动总结",
  );
});

test("模型只回了客套话：返回空串，保留临时标题", () => {
  assert.equal(normalizeSessionTitle("你好，很高兴为你服务。"), "");
});

test("模型输出：超长截断到上限", () => {
  const title = normalizeSessionTitle(
    "这是一个明显超过标题字数上限的会话标题示例内容",
  );
  assert.ok(Array.from(title).length <= SESSION_TITLE_MAX_CHARS);
});

test("本地兜底：去掉开头的寒暄与口头语", () => {
  assert.equal(
    condenseSessionTitle("请帮我优化一下新建会话的工作区选择"),
    "优化新建会话的工作区选择",
  );
});

test("本地兜底：只取第一句", () => {
  assert.equal(
    condenseSessionTitle("帮我修复登录问题。顺便看看样式"),
    "修复登录问题",
  );
});

test("本地兜底：超长时限制字数", () => {
  const title = condenseSessionTitle(
    "请帮我优化一下新建会话时工作区总是不会自动选择的问题",
  );
  assert.ok(Array.from(title).length <= SESSION_TITLE_MAX_CHARS);
});

test("本地兜底：代码块与链接不进入标题", () => {
  assert.equal(
    condenseSessionTitle("看看 https://example.com/a 这段 ```const a = 1``` 有什么问题"),
    "看看这段有什么问题",
  );
});

test("提示词包含问题原文与字数要求", () => {
  const prompt = buildSessionTitlePrompt("新建会话如何默认选中工作区？");
  assert.match(prompt, /新建会话如何默认选中工作区/);
  assert.match(prompt, new RegExp(String(SESSION_TITLE_MAX_CHARS)));
});
