import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatKeyValue,
  parseKeyValueLines,
  splitArgs,
} from "../src/shared/mcp.ts";

test("splitArgs 支持单双引号", () => {
  assert.deepEqual(splitArgs(`-y "@scope/pkg" 'a b' plain`), [
    "-y",
    "@scope/pkg",
    "a b",
    "plain",
  ]);
});

test("parseKeyValueLines 忽略空行、注释与无等号行", () => {
  assert.deepEqual(
    parseKeyValueLines("\n# 注释\nTOKEN=${MCP_TOKEN}\nBROKEN\nLOG=info\n"),
    { TOKEN: "${MCP_TOKEN}", LOG: "info" },
  );
});

test("formatKeyValue 与 parseKeyValueLines 往返一致", () => {
  const input = { TOKEN: "${MCP_TOKEN}", LOG: "info" };
  assert.deepEqual(parseKeyValueLines(formatKeyValue(input)), input);
});
