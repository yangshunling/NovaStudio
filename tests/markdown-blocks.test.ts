import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MARKDOWN_BLOCK_THRESHOLD,
  splitMarkdownBlocks,
} from "../src/renderer/lib/markdown-blocks.ts";

test("按空行切分段落，最后一段作为尾巴", () => {
  const content = "第一段\n\n第二段\n\n第三段还在增长";
  const { stable, tail } = splitMarkdownBlocks(content);
  assert.deepEqual(stable, ["第一段", "第二段"]);
  assert.equal(tail, "第三段还在增长");
});

test("围栏代码块内部的空行不是块边界", () => {
  const content = [
    "说明文字",
    "",
    "```ts",
    "const a = 1;",
    "",
    "const b = 2;",
    "```",
    "",
    "后续段落",
  ].join("\n");
  const { stable, tail } = splitMarkdownBlocks(content);
  assert.deepEqual(stable, [
    "说明文字",
    "```ts\nconst a = 1;\n\nconst b = 2;\n```",
  ]);
  assert.equal(tail, "后续段落");
});

test("松列表的条目不会被拆成多个列表", () => {
  const content = ["- 第一项", "", "- 第二项", "", "- 第三项", "", "结尾段落"].join(
    "\n",
  );
  const { stable, tail } = splitMarkdownBlocks(content);
  assert.deepEqual(stable, ["- 第一项\n\n- 第二项\n\n- 第三项"]);
  assert.equal(tail, "结尾段落");
});

test("有序列表同样保持完整", () => {
  const content = ["1. 一", "", "2. 二", "", "3. 三"].join("\n");
  const { stable, tail } = splitMarkdownBlocks(content);
  assert.deepEqual(stable, []);
  assert.equal(tail, content);
});

test("列表项的缩进续段与列表保持在同一块", () => {
  const content = ["- 第一项", "", "  续段文字", "", "独立段落"].join("\n");
  const { stable, tail } = splitMarkdownBlocks(content);
  assert.deepEqual(stable, ["- 第一项\n\n  续段文字"]);
  assert.equal(tail, "独立段落");
});

test("出现引用式链接定义时放弃切分", () => {
  const content = "参见 [文档][doc]。\n\n[doc]: https://example.com\n\n后续";
  const { stable, tail } = splitMarkdownBlocks(content);
  assert.deepEqual(stable, []);
  assert.equal(tail, content);
});

test("只有一块时不切分", () => {
  const content = "一整段没有任何空行的内容";
  const { stable, tail } = splitMarkdownBlocks(content);
  assert.deepEqual(stable, []);
  assert.equal(tail, content);
});

test("切成多块时总内容不丢失（除块间空行）", () => {
  const content = "A\n\nB\n\nC\n";
  const { stable, tail } = splitMarkdownBlocks(content);
  const rebuilt = [...stable, tail].join("\n\n");
  assert.equal(rebuilt, "A\n\nB\n\nC");
});

test("阈值是给调用方判断的成本分界", () => {
  assert.equal(MARKDOWN_BLOCK_THRESHOLD, 8000);
});
