import assert from "node:assert/strict";
import { test } from "node:test";
import { createBatchQueue } from "../src/main/ipc/batch.ts";

test("窗口内的多条事件合并成一批，顺序保持入队顺序", async () => {
  const sent: number[] = [];
  const queue = createBatchQueue<number>(5, (item) => sent.push(item));

  queue.push(1);
  queue.push(2);
  queue.push(3);
  assert.equal(queue.size, 3);
  assert.deepEqual(sent, []);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent, [1, 2, 3]);
  assert.equal(queue.size, 0);
});

test("flush 立即发送并取消定时器：同一批不会重复发送", async () => {
  const sent: string[] = [];
  const queue = createBatchQueue<string>(5, (item) => sent.push(item));

  queue.push("a");
  queue.push("b");
  queue.flush();
  assert.deepEqual(sent, ["a", "b"]);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent, ["a", "b"]);
});

test("空队列 flush 不触发发送", () => {
  const sent: number[] = [];
  const queue = createBatchQueue<number>(5, (item) => sent.push(item));

  queue.flush();
  assert.deepEqual(sent, []);
});

test("flush 期间重入入队的内容留到下一批", () => {
  const sent: number[] = [];
  const queue = createBatchQueue<number>(5, (item) => {
    sent.push(item);
    // 模拟 flush 过程中又有新事件到达（例如收尾事件）
    if (item === 1) queue.push(2);
  });

  queue.push(1);
  queue.flush();
  assert.deepEqual(sent, [1]);
  assert.equal(queue.size, 1);

  queue.flush();
  assert.deepEqual(sent, [1, 2]);
});
