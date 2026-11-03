import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeTriggerSchedule,
  nextTriggerFireAt,
  normalizeTriggerSchedule,
} from "../src/shared/trigger-schedule.ts";

test("损坏的规则回退到每天 09:00", () => {
  assert.deepEqual(normalizeTriggerSchedule({ kind: "unknown" }), {
    kind: "daily",
    time: "09:00",
  });
});

test("interval 分钟数被夹到 1..1440", () => {
  assert.deepEqual(normalizeTriggerSchedule({ kind: "interval", minutes: 0 }), {
    kind: "interval",
    minutes: 1,
  });
  assert.deepEqual(
    normalizeTriggerSchedule({ kind: "interval", minutes: 99999 }),
    { kind: "interval", minutes: 1440 },
  );
});

test("weekly 无有效星期时回退到工作日", () => {
  const schedule = normalizeTriggerSchedule({
    kind: "weekly",
    time: "18:30",
    weekdays: [9, -1],
  });
  assert.deepEqual(schedule, { kind: "weekly", time: "18:30", weekdays: [1, 2, 3, 4, 5] });
});

test("daily 严格返回晚于 from 的时刻", () => {
  // 2026-01-05 是周一；本地时间 08:00 时，下一次 09:00 是当天
  const from = new Date(2026, 0, 5, 8, 0, 0, 0).getTime();
  const next = nextTriggerFireAt({ kind: "daily", time: "09:00" }, from);
  assert.equal(next, new Date(2026, 0, 5, 9, 0, 0, 0).getTime());

  const after = nextTriggerFireAt(
    { kind: "daily", time: "09:00" },
    new Date(2026, 0, 5, 9, 0, 0, 0).getTime(),
  );
  assert.equal(after, new Date(2026, 0, 6, 9, 0, 0, 0).getTime());
});

test("weekly 只在选中的星期触发", () => {
  const from = new Date(2026, 0, 5, 10, 0, 0, 0).getTime(); // 周一
  const next = nextTriggerFireAt(
    { kind: "weekly", time: "09:00", weekdays: [3] },
    from,
  );
  assert.equal(next, new Date(2026, 0, 7, 9, 0, 0, 0).getTime()); // 周三
});

test("interval 从 from 起算", () => {
  const from = 1_000_000;
  assert.equal(
    nextTriggerFireAt({ kind: "interval", minutes: 30 }, from),
    from + 30 * 60_000,
  );
});

test("规则摘要可读", () => {
  assert.equal(describeTriggerSchedule({ kind: "daily", time: "09:00" }), "每天 09:00");
  assert.equal(
    describeTriggerSchedule({ kind: "interval", minutes: 120 }),
    "每隔 2 小时",
  );
});
