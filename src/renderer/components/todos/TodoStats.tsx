/**
 * 待办统计
 *
 * 右栏的完成情况卡：
 * - 完成率圆环，中心是百分比
 * - 待处理 / 已逾期 / 今日完成 / 连续处理四个小格
 * - 最近 7 天的完成柱状图（进入时从底部生长一次，可用 reduced-motion 关闭）
 */

import { useEffect, useMemo, useState } from "react";
import type { TodoItem } from "@shared/types";
import { completionSeries, completionStreak, isOverdue } from "./todoUtils";

const RING_SIZE = 92;
const RING_STROKE = 6;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function TodoStats({ todos }: { todos: TodoItem[] }) {
  const stats = useMemo(() => {
    const total = todos.length;
    const done = todos.filter((item) => item.done).length;
    const pending = total - done;
    const overdue = todos.filter((item) => isOverdue(item)).length;
    const series = completionSeries(todos, 7);
    const todayDone = series[series.length - 1]?.count ?? 0;
    const weekDone = series.reduce((sum, day) => sum + day.count, 0);
    const streak = completionStreak(todos);
    return {
      total,
      done,
      pending,
      overdue,
      todayDone,
      weekDone,
      streak,
      rate: total === 0 ? 0 : done / total,
      series,
    };
  }, [todos]);

  // 首帧先画整圈，下一帧再收到目标值，让圆环有一次生长动画
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const offset = mounted
    ? RING_CIRCUMFERENCE * (1 - stats.rate)
    : RING_CIRCUMFERENCE;
  const maxCount = Math.max(1, ...stats.series.map((day) => day.count));

  return (
    <section className="rounded-2xl border border-border/70 bg-surface-2/40 p-4 shadow-[var(--c-shadow-sm)]">
      <div className="flex items-baseline justify-between">
        <h3 className="text-meta font-semibold text-text-secondary">完成情况</h3>
        <span className="text-caption tabular-nums text-text-muted">
          共 {stats.total} 件
        </span>
      </div>

      <div className="mt-3 flex items-center gap-4">
        <div className="relative h-20 w-20 shrink-0">
          <svg
            viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
            className="h-full w-full -rotate-90"
            aria-hidden
          >
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="var(--c-surface-hover)"
              strokeWidth={RING_STROKE}
            />
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="var(--c-accent)"
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={offset}
              className="transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-title font-semibold tabular-nums text-text">
              {Math.round(stats.rate * 100)}%
            </span>
            <span className="text-caption text-text-muted">完成率</span>
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-caption text-text-muted">累计完成</div>
          <div className="mt-0.5 text-heading font-semibold tabular-nums text-text">
            {stats.done}
            <span className="ml-0.5 text-meta font-normal text-text-muted">
              件
            </span>
          </div>
          <div className="mt-1 text-caption text-text-muted">
            还剩 {stats.pending} 件
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Metric label="待处理" value={stats.pending} />
        <Metric
          label="已逾期"
          value={stats.overdue}
          tone={stats.overdue > 0 ? "error" : "default"}
        />
        <Metric label="今日完成" value={stats.todayDone} />
        <Metric label="连续处理" value={stats.streak} suffix="天" />
      </div>

      <div className="mt-4 border-t border-border/60 pt-3.5">
        <div className="flex items-baseline justify-between">
          <span className="text-meta font-medium text-text-secondary">
            最近 7 天
          </span>
          <span className="text-caption tabular-nums text-text-muted">
            完成 {stats.weekDone} 件
          </span>
        </div>

        <div className="mt-3 flex items-end gap-1.5">
          {stats.series.map((day, index) => {
            const height =
              day.count === 0
                ? 3
                : Math.round(6 + (day.count / maxCount) * 28);
            return (
              <div
                key={day.ts}
                className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
              >
                <div
                  className="flex h-9 w-full items-end justify-center"
                  title={`${day.label}，完成 ${day.count} 件`}
                >
                  <div
                    className={`todo-bar w-2 rounded-full ${
                      day.count === 0
                        ? "bg-surface-hover"
                        : day.isToday
                          ? "bg-accent"
                          : "bg-accent/55"
                    }`}
                    style={{
                      height,
                      animationDelay: `${index * 40}ms`,
                    }}
                  />
                </div>
                <span
                  className={`text-caption ${
                    day.isToday
                      ? "font-semibold text-accent"
                      : "text-text-muted"
                  }`}
                >
                  {day.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  suffix,
  tone = "default",
}: {
  label: string;
  value: number;
  suffix?: string;
  tone?: "default" | "error";
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-surface/60 px-2.5 py-2">
      <div className="text-caption text-text-muted">{label}</div>
      <div
        className={`mt-0.5 text-title font-semibold tabular-nums ${
          tone === "error" ? "text-error" : "text-text"
        }`}
      >
        {value}
        {suffix && (
          <span className="ml-0.5 text-caption font-normal text-text-muted">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}
