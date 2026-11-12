import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_REPORT_OPTIONS,
  buildWeeklyReportPrompt,
  collectReportBundle,
  resolveReportRange,
  stripReportMarkdown,
} from "../src/shared/report.ts";
import type { TodoItem } from "../src/shared/types.ts";

function at(year: number, month: number, day: number, hour = 0): number {
  return new Date(year, month - 1, day, hour).getTime();
}

function todo(overrides: Partial<TodoItem> & { id: string }): TodoItem {
  return {
    title: overrides.id,
    note: "",
    priority: "normal",
    dueAt: null,
    tags: [],
    done: false,
    completedAt: null,
    sortOrder: 0,
    createdAt: at(2026, 11, 1),
    updatedAt: at(2026, 11, 1),
    ...overrides,
  };
}

// 2026-11-12 是周四，本周为 11-09 ~ 11-15
const NOW = at(2026, 11, 12, 10);

test("本周从周一 0 点开始，共 7 天", () => {
  const range = resolveReportRange("this-week", null, null, NOW);
  assert.equal(range.start, at(2026, 11, 9));
  assert.equal(range.end, at(2026, 11, 16));
});

test("自定义区间包含结束日当天；起止填反时兜底一天", () => {
  const range = resolveReportRange(
    "custom",
    at(2026, 11, 3),
    at(2026, 11, 5),
    NOW,
  );
  assert.equal(range.start, at(2026, 11, 3));
  assert.equal(range.end, at(2026, 11, 6));

  const reversed = resolveReportRange(
    "custom",
    at(2026, 11, 5),
    at(2026, 11, 3),
    NOW,
  );
  assert.equal(reversed.end, reversed.start + 24 * 3600 * 1000);
});

test("已完成按完成时间归周，未完成按截止时间归周", () => {
  const range = resolveReportRange("this-week", null, null, NOW);
  const bundle = collectReportBundle(
    [
      todo({
        id: "本周完成",
        done: true,
        tags: ["周报", "AIGC"],
        completedAt: at(2026, 11, 11, 18),
      }),
      todo({
        id: "上周完成",
        done: true,
        tags: ["周报", "AIGC"],
        completedAt: at(2026, 11, 8, 18),
      }),
      todo({ id: "本周到期", tags: ["周报", "会议"], dueAt: at(2026, 11, 12) }),
      todo({ id: "下周一到期", tags: ["周报", "会议"], dueAt: at(2026, 11, 16) }),
    ],
    range,
    DEFAULT_REPORT_OPTIONS,
  );

  assert.deepEqual(
    bundle.done.map((entry) => entry.title),
    ["本周完成"],
  );
  assert.deepEqual(
    bundle.pending.map((entry) => entry.title),
    ["本周到期"],
  );
  assert.deepEqual(bundle.sections, ["AIGC", "会议"]);
});

test("无日期事项默认排除，显式勾选后纳入", () => {
  const range = resolveReportRange("this-week", null, null, NOW);
  const items = [todo({ id: "无日期", tags: ["工作"] })];

  assert.equal(
    collectReportBundle(items, range, DEFAULT_REPORT_OPTIONS).entries.length,
    0,
  );
  assert.equal(
    collectReportBundle(items, range, {
      ...DEFAULT_REPORT_OPTIONS,
      includeUndated: true,
    }).entries.length,
    1,
  );
});

test("排除板块不区分大小写", () => {
  const range = resolveReportRange("this-week", null, null, NOW);
  const bundle = collectReportBundle(
    [
      todo({ id: "会议一", tags: ["会议"], dueAt: at(2026, 11, 11) }),
      todo({ id: "任务一", tags: ["AIGC"], dueAt: at(2026, 11, 11) }),
    ],
    range,
    { ...DEFAULT_REPORT_OPTIONS, excludeSections: ["会议"] },
  );
  assert.deepEqual(
    bundle.entries.map((entry) => entry.title),
    ["任务一"],
  );
});

test("prompt 按板块列出记录，且不包含被排除的内容", () => {
  const range = resolveReportRange("this-week", null, null, NOW);
  const items = [
    todo({
      id: "完成事项",
      done: true,
      tags: ["AIGC"],
      completedAt: at(2026, 11, 11),
    }),
    todo({ id: "会议事项", tags: ["会议"], dueAt: at(2026, 11, 12) }),
  ];

  const prompt = buildWeeklyReportPrompt(
    collectReportBundle(items, range, DEFAULT_REPORT_OPTIONS),
    range,
    DEFAULT_REPORT_OPTIONS,
  );
  assert.match(prompt, /### AIGC\n- 完成事项/);
  assert.match(prompt, /2026-11-09 至 2026-11-15/);

  const excluded = buildWeeklyReportPrompt(
    collectReportBundle(items, range, {
      ...DEFAULT_REPORT_OPTIONS,
      excludeSections: ["会议"],
    }),
    range,
    { ...DEFAULT_REPORT_OPTIONS, excludeSections: ["会议"] },
  );
  assert.doesNotMatch(excluded, /会议事项/);
});

test("整段代码围栏会被去掉，正文内部的保持原样", () => {
  assert.equal(
    stripReportMarkdown("```markdown\n# 周报\n- 事项\n```"),
    "# 周报\n- 事项",
  );
  assert.equal(
    stripReportMarkdown("# 周报\n```\ncode\n```"),
    "# 周报\n```\ncode\n```",
  );
});
