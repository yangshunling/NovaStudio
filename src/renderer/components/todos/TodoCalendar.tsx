/**
 * 万年历
 *
 * 点选任意日期后，左侧台账切换到「那一天」：日期主视觉、页签计数与
 * 新待办的默认截止日期都会跟着走。再次点击已选日期或点「回到全部」清除。
 *
 * 日期下方的小圆点表示当天有截止任务：
 * - 红：有过期未完成
 * - 蓝：有未完成
 * - 灰：只有已完成
 */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { TodoItem } from "@shared/types";
import { startOfDay } from "./todoUtils";

interface TodoCalendarProps {
  todos: TodoItem[];
  selectedDate: number | null;
  onSelectDate: (date: number | null) => void;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function startOfMonth(ts: number): number {
  const date = new Date(ts);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function TodoCalendar({
  todos,
  selectedDate,
  onSelectDate,
}: TodoCalendarProps) {
  const now = Date.now();
  const today = startOfDay(now);
  const [viewMonth, setViewMonth] = useState(() =>
    startOfMonth(selectedDate ?? now),
  );

  /** 按天汇总截止任务，供日期下方的小圆点使用 */
  const dayMarks = useMemo(() => {
    const marks = new Map<
      number,
      { pending: number; done: number; overdue: boolean }
    >();
    for (const todo of todos) {
      if (todo.dueAt === null) continue;
      const key = startOfDay(todo.dueAt);
      const mark = marks.get(key) ?? {
        pending: 0,
        done: 0,
        overdue: false,
      };
      if (todo.done) {
        mark.done += 1;
      } else {
        mark.pending += 1;
        if (key < today) mark.overdue = true;
      }
      marks.set(key, mark);
    }
    return marks;
  }, [todos, today]);

  /** 固定 6 行 × 7 列，避免切换月份时网格高度跳动 */
  const cells = useMemo(() => {
    const first = new Date(viewMonth);
    const offset = (first.getDay() + 6) % 7; // 周一为第一列
    const start = new Date(first);
    start.setDate(first.getDate() - offset);
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date.getTime();
    });
  }, [viewMonth]);

  const monthDate = new Date(viewMonth);
  const monthLabel = `${monthDate.getFullYear()}年${monthDate.getMonth() + 1}月`;

  const shiftMonth = (delta: number) => {
    const next = new Date(viewMonth);
    next.setMonth(next.getMonth() + delta, 1);
    next.setHours(0, 0, 0, 0);
    setViewMonth(next.getTime());
  };

  const goToday = () => {
    setViewMonth(startOfMonth(now));
    onSelectDate(today);
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            aria-label="上个月"
            className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[92px] text-center text-body font-medium text-text">
            {monthLabel}
          </span>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            aria-label="下个月"
            className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={goToday}
          className="shrink-0 text-meta text-text-muted transition-colors hover:text-text"
        >
          今天
        </button>
      </div>

      <div className="mt-4 grid grid-cols-7 text-center">
        {WEEKDAYS.map((day) => (
          <span key={day} className="pb-1 text-caption text-text-muted">
            {day}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {cells.map((ts) => {
          const date = new Date(ts);
          const inMonth =
            date.getMonth() === monthDate.getMonth() &&
            date.getFullYear() === monthDate.getFullYear();
          const isToday = ts === today;
          const isSelected = selectedDate !== null && ts === selectedDate;
          const mark = dayMarks.get(ts);
          const dot = mark
            ? mark.overdue
              ? "bg-error"
              : mark.pending > 0
                ? "bg-accent"
                : "bg-text-muted/40"
            : null;
          const dotClass = isToday ? "bg-accent-foreground/75" : dot;

          const stateClass = isToday
            ? `bg-accent font-medium text-accent-foreground ${
                isSelected
                  ? "ring-2 ring-accent/30 ring-offset-2 ring-offset-bg"
                  : ""
              }`
            : isSelected
              ? "ring-1 ring-accent text-accent"
              : inMonth
                ? "text-text-secondary hover:bg-surface-hover hover:text-text"
                : "text-text-muted/40 hover:bg-surface-hover/60";

          const taskCount = mark ? mark.pending + mark.done : 0;

          return (
            <button
              key={ts}
              type="button"
              onClick={() => {
                if (!inMonth) setViewMonth(startOfMonth(ts));
                onSelectDate(isSelected ? null : ts);
              }}
              aria-label={`${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日${
                taskCount > 0 ? `，${taskCount} 件任务` : ""
              }`}
              aria-pressed={isSelected}
              className={`relative mx-auto flex h-8 w-8 items-center justify-center rounded-full text-meta transition-colors ${stateClass}`}
            >
              {date.getDate()}
              {dot && (
                <span
                  aria-hidden
                  className={`absolute bottom-0.5 h-1 w-1 rounded-full ${dotClass}`}
                />
              )}
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-caption leading-relaxed text-text-muted">
        圆点表示当天有截止任务；点日期可只看当天。
      </p>
    </section>
  );
}
