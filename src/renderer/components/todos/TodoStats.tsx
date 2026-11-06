/**
 * 待办统计
 *
 * 右栏的第二块内容：
 * - 完成率圆环，中心是累计完成数
 * - 待处理 / 已逾期 / 今日完成 / 连续处理天数
 * - 最近 7 天的完成柱状图（进入时从底部生长一次，可用 reduced-motion 关闭）
 */

import { useEffect, useMemo, useState } from "react";
import type { TodoItem } from "@shared/types";
import {
  completionSeries,
  completionStreak,
  isOverdue,
} from "./todoUtils";

const RING_SIZE = 92;
const RING_STROKE = 5;
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
    <section>
      <div className="flex items-center gap-4">
        <div className="relative h-[92px] w-[92px] shrink-0">
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
              {stats.done}
            </span>
            <span className="mt-0.5 text-caption text-text-muted">
              累计完成
            </span>
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-caption text-text-muted">完成率</div>
          <div className="mt-0.5 text-heading font-semibold tabular-nums text-text">
            {Math.round(stats.rate * 100)}%
          </div>
          <div className="mt-1 text-caption text-text-muted">
            共 {stats.total} 件
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        <Metric label="待处理" value={stats.pending} />
        <Metric
          label="已逾期"
          value={stats.overdue}
          tone={stats.overdue > 0 ? "error" : "default"}
        />
        <Metric label="今日完成" value={stats.todayDone} />
        <Metric label="连续处理" value={stats.streak} suffix="天" />
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-meta text-text-secondary">最近 7 天</span>
          <span className="text-caption text-text-muted">
            完成 {stats.weekDone} 件
          </span>
        </div>

        <div className="mt-3 flex items-end gap-1">
          {stats.series.map((day, index) => {
            const height =
              day.count === 0
                ? 3
                : Math.round(6 + (day.count / maxCount) * 30);
            return (
              <div
                key={day.ts}
                className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
              >
                <div
                  className="flex h-8 w-full items-end justify-center"
                  title={`${day.label}，完成 ${day.count} 件`}
                >
                  <div
                    className={`todo-bar w-2 rounded-full ${
                      day.count === 0
                        ? "bg-surface-hover"
                        : day.isToday
                          ? "bg-accent"
                          : "bg-accent/60"
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
                      ? "font-medium text-accent"
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
    <div>
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
