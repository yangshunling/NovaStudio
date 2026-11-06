/**
 * 待办列表行 — 台账式排版
 *
 * 一行只有三层信息：标题（带优先级色点）、备注摘要、标签 / 完成时间。
 * 截止日期右对齐在标题行，用颜色表达紧迫程度；不再使用填充胶囊。
 * 静止时几乎没有装饰，hover 才出现拖拽手柄与操作按钮。
 */

import { useState } from "react";
import { Check, GripVertical, Pencil } from "lucide-react";
import type { TodoItem, TodoPriority } from "@shared/types";
import { ConfirmDeleteButton } from "../ui/ConfirmDeleteButton";
import {
  PRIORITY_LABEL,
  dueBucket,
  formatCompletedAt,
  formatDueLabel,
  isOverdue,
} from "./todoUtils";

export type DragPosition = "before" | "after";

interface TodoRowProps {
  todo: TodoItem;
  /** 当前排序是否为手动排序；只有手动排序时才能拖动 */
  manualSort: boolean;
  /** 是否有行正在被拖动（用于让其它行接受 dragover） */
  dragActive: boolean;
  dragging: boolean;
  dropPosition: DragPosition | null;
  /** 日视图里所有条目共享同一天，隐藏右侧重复的截止日期 */
  hideDue?: boolean;
  onToggle: (todo: TodoItem) => void;
  onEdit: (todo: TodoItem) => void;
  onDelete: (todo: TodoItem) => void;
  onTagClick?: (tag: string) => void;
  onDragStart: (id: string) => void;
  onDragOver: (id: string, position: DragPosition) => void;
  onDrop: (id: string, position: DragPosition) => void;
  onDragEnd: () => void;
}

const PRIORITY_DOT: Record<TodoPriority, string> = {
  high: "bg-error",
  normal: "bg-accent/70",
  low: "bg-text-muted/40",
};

export function TodoRow({
  todo,
  manualSort,
  dragActive,
  dragging,
  dropPosition,
  hideDue = false,
  onToggle,
  onEdit,
  onDelete,
  onTagClick,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TodoRowProps) {
  // 只在按住手柄后把行设为 draggable，避免整行都能拖走
  const [armed, setArmed] = useState(false);

  const overdue = isOverdue(todo);
  const bucket = dueBucket(todo.dueAt);
  const dueClass = overdue
    ? "text-error"
    : bucket === "today"
      ? "text-accent"
      : "text-text-muted";

  const dropLine = (position: DragPosition) =>
    dropPosition === position ? (
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-x-2 h-px bg-accent ${
          position === "before" ? "top-0" : "bottom-0"
        }`}
      />
    ) : null;

  return (
    <li
      draggable={armed && !todo.done}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", todo.id);
        onDragStart(todo.id);
      }}
      onDragEnd={() => {
        setArmed(false);
        onDragEnd();
      }}
      onDragOver={(event) => {
        if (!dragActive || todo.done) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        onDragOver(
          todo.id,
          event.clientY < rect.top + rect.height / 2 ? "before" : "after",
        );
      }}
      onDrop={(event) => {
        if (!dragActive || todo.done) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onDrop(
          todo.id,
          event.clientY < rect.top + rect.height / 2 ? "before" : "after",
        );
        setArmed(false);
      }}
      className={`group relative flex items-start gap-2 py-3 pl-6 pr-2 transition-colors hover:bg-surface-hover/30 ${
        dragging ? "opacity-40" : ""
      }`}
    >
      {dropLine("before")}

      {/* 拖拽手柄槽位固定占位，避免 hover 时整行内容跳动 */}
      <span className="mt-0.5 flex w-4 shrink-0 justify-center">
        {manualSort && !todo.done && (
          <button
            type="button"
            onMouseDown={() => setArmed(true)}
            onMouseUp={() => setArmed(false)}
            title="拖动调整顺序"
            aria-label="拖动调整顺序"
            className="pointer-events-none cursor-grab rounded p-0.5 text-text-muted opacity-0 transition-opacity hover:text-text active:cursor-grabbing group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        )}
      </span>

      <button
        type="button"
        role="checkbox"
        aria-checked={todo.done}
        aria-label={todo.done ? `取消完成：${todo.title}` : `标记完成：${todo.title}`}
        onClick={() => onToggle(todo)}
        className={`mt-[3px] grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border transition-colors ${
          todo.done
            ? "border-accent bg-accent text-accent-foreground"
            : "border-text-muted/40 text-transparent hover:border-accent hover:text-accent/50"
        }`}
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            {!todo.done && (
              <span
                title={`优先级：${PRIORITY_LABEL[todo.priority]}`}
                className={`mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[todo.priority]}`}
              />
            )}
            <span
              className={`min-w-0 break-words text-body-lg leading-6 ${
                todo.done
                  ? "text-text-muted line-through decoration-text-muted/50"
                  : "font-medium text-text"
              }`}
            >
              {todo.title}
            </span>
          </div>

          {!todo.done && !hideDue && todo.dueAt !== null && (
            <span
              className={`mt-px shrink-0 text-caption leading-6 ${dueClass}`}
              title={
                overdue
                  ? `已逾期，原定 ${formatDueLabel(todo.dueAt)}`
                  : `截止：${formatDueLabel(todo.dueAt)}`
              }
            >
              {formatDueLabel(todo.dueAt)}
            </span>
          )}
        </div>

        {todo.note && (
          <p className="mt-0.5 line-clamp-1 text-meta leading-relaxed text-text-muted">
            {todo.note}
          </p>
        )}

        {(todo.tags.length > 0 || todo.done) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {todo.tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => onTagClick?.(tag)}
                title={`按标签 #${tag} 筛选`}
                className="text-caption text-text-muted transition-colors hover:text-accent"
              >
                #{tag}
              </button>
            ))}
            {todo.done && todo.completedAt !== null && (
              <span className="text-caption text-text-muted">
                完成于 {formatCompletedAt(todo.completedAt)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 操作区固定占位，hover 时淡入，不挤动正文 */}
      <div className="pointer-events-none -mt-1 flex w-[68px] shrink-0 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <button
          type="button"
          onClick={() => onEdit(todo)}
          title="编辑"
          aria-label="编辑"
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <ConfirmDeleteButton onConfirm={() => onDelete(todo)} />
      </div>

      {dropLine("after")}
    </li>
  );
}
