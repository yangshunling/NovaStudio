import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * 生命周期状态机是退出链路的地基：步骤漏跑会让进程退不掉，
 * 乱序会让 Agent 收尾写不进已关闭的库。这里只测纯状态机，
 * Electron 相关的确认框/日志由生命周期外层模块负责。
 */
const bundled = await build({
  entryPoints: [
    fileURLToPath(new URL("../src/main/lifecycle/machine.ts", import.meta.url)),
  ],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const { createLifecycle } = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)) as typeof import("../src/main/lifecycle/machine.ts");

test("退出步骤按 order 执行", async () => {
  const runs: string[] = [];
  const lifecycle = createLifecycle();
  lifecycle.register({
    name: "later",
    order: 20,
    run: () => {
      runs.push("later");
    },
  });
  lifecycle.register({
    name: "earlier",
    order: 10,
    run: () => {
      runs.push("earlier");
    },
  });

  await lifecycle.dispose("test");
  assert.deepEqual(runs, ["earlier", "later"]);
  assert.equal(lifecycle.phase, "disposed");
});

test("单步抛错不影响后续步骤", async () => {
  const runs: string[] = [];
  const lifecycle = createLifecycle();
  lifecycle.register({
    name: "boom",
    order: 10,
    run: () => {
      throw new Error("boom");
    },
  });
  lifecycle.register({
    name: "database",
    order: 100,
    run: () => {
      runs.push("database");
    },
  });

  await lifecycle.dispose("test");
  assert.deepEqual(runs, ["database"]);
});

test("单步超时后继续执行后续步骤", async () => {
  const runs: string[] = [];
  const lifecycle = createLifecycle();
  lifecycle.register({
    name: "hang",
    order: 10,
    timeoutMs: 20,
    run: () => new Promise<void>(() => {}),
  });
  lifecycle.register({
    name: "database",
    order: 100,
    run: () => {
      runs.push("database");
    },
  });

  await lifecycle.dispose("test");
  assert.deepEqual(runs, ["database"]);
});

test("重复 dispose 只执行一次清理", async () => {
  let count = 0;
  const lifecycle = createLifecycle();
  lifecycle.register({
    name: "once",
    order: 10,
    run: () => {
      count += 1;
    },
  });

  await Promise.all([lifecycle.dispose("first"), lifecycle.dispose("second")]);
  await lifecycle.dispose("third");
  assert.equal(count, 1);
});

test("状态机：ready 之后才开始清理，清理开始即 isClosing", async () => {
  const lifecycle = createLifecycle();
  assert.equal(lifecycle.phase, "starting");
  assert.equal(lifecycle.isReady(), false);

  lifecycle.markReady();
  assert.equal(lifecycle.phase, "ready");
  assert.equal(lifecycle.isReady(), true);
  assert.equal(lifecycle.isClosing(), false);

  const done = lifecycle.dispose("test");
  assert.equal(lifecycle.isClosing(), true);
  await done;
  assert.equal(lifecycle.phase, "disposed");
});
