import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * 只测版本比较：升级命令本身会访问网络 / 修改全局安装，不适合放进单测。
 * 比较规则若写错，会让「已是最新」被误报成「有更新」，或反之。
 */
const bundled = await build({
  entryPoints: [
    fileURLToPath(new URL("../src/main/agents/claude/upgrade.ts", import.meta.url)),
  ],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const upgrade = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)) as typeof import("../src/main/agents/claude/upgrade.ts");

test("版本号按数字段比较，不按字符串比较", () => {
  assert.ok(upgrade.compareVersions("2.1.10", "2.1.9") > 0);
  assert.ok(upgrade.compareVersions("2.1.9", "2.1.10") < 0);
  assert.equal(upgrade.compareVersions("2.1.322", "2.1.322"), 0);
});

test("忽略 v 前缀与尾随说明文字", () => {
  assert.equal(upgrade.compareVersions("v2.1.322", "2.1.322"), 0);
  assert.ok(upgrade.compareVersions("2.2.0 (Claude Code)", "2.1.322") > 0);
});

test("同版本号时稳定版高于预发布版", () => {
  assert.ok(upgrade.compareVersions("2.1.0", "2.1.0-beta.1") > 0);
  assert.ok(upgrade.compareVersions("2.1.0-beta.1", "2.1.0") < 0);
});

test("主版本差异优先于次版本差异", () => {
  assert.ok(upgrade.compareVersions("3.0.0", "2.99.99") > 0);
});
