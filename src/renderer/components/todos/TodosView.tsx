/**
 * 待办事项页
 *
 * 版面是「工作台」而不是表格：
 * - 顶部一张概览卡：日期主视觉 + 一句话摘要 + 一条完成进度
 * - 中部按截止时间分组，每组是一张带表头的卡片，条目之间用细线分隔
 * - 右侧日历与统计各自独立成卡，与主列表形成主次关系
 *
 * 交互规则保持不变：
 * - 未完成按截止日期分组；已完成单独一栏，按完成时间倒序
 * - 手动排序时可同组拖动；跨组拖动会改变分组语义，因此不允许
 */

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ArrowUpDown, Inbox, ListTodo, Plus, Tag, Trash2 } from "lucide-react";
import type { TodoDraft, TodoItem } from "@shared/types";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { useLoad } from "../../hooks/useLoad";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import { Page, PageBody, PageHeader } from "../ui/Page";
import { Button } from "../ui/Button";
import { SearchInput } from "../ui/SearchInput";
import { Select } from "../ui/Select";
import { SegmentedTabs } from "../ui/SegmentedTabs";
import { EmptyState, ErrorState, LoadingState } from "../ui/EmptyState";
import { TodoComposer } from "./TodoComposer";
import { TodoCalendar } from "./TodoCalendar";
import { TodoEditorDialog } from "./TodoEditorDialog";
import { TodoRow, type DragPosition } from "./TodoRow";
import { TodoStats } from "./TodoStats";
import {
  SORT_OPTIONS,
  collectTags,
  dueBucket,
  formatDateLabel,
  groupTodos,
  isOverdue,
  sortTodos,
  startOfDay,
  weekdayShort,
  type DueBucket,
  type TodoFilter,
  type TodoSort,
} from "./todoUtils";

const VIEW_TABS: { id: TodoFilter; label: string }[] = [
  { id: "pending", label: "未完成" },
  { id: "all", label: "全部" },
  { id: "done", label: "已完成" },
];

/** 分组表头左侧的状态点：逾期红、今天蓝，其余随文本层级递减 */
const GROUP_TONE: Record<DueBucket, string> = {
  overdue: "bg-error",
  today: "bg-accent",
  week: "bg-text-secondary",
  later: "bg-text-muted/60",
  none: "bg-text-muted/30",
};

export function TodosView() {
  const {
    data: todos,
    loading,
    error,
    reload,
    setData,
  } = useLoad(() => ipc.listTodos(), [] as TodoItem[]);

  const [filter, setFilter] = useState<TodoFilter>("pending");
  const [sort, setSort] = useState<TodoSort>("manual");
  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  /** 日历选中的日期（本地 0 点）；null 表示不按日期筛选 */
  const [selectedDate, setSelectedDate] = useState<number | null>(null);
  const [editing, setEditing] = useState<TodoItem | "new" | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    position: DragPosition;
  } | null>(null);

  const pendingCount = todos.reduce(
    (count, item) => count + (item.done ? 0 : 1),
    0,
  );
  const doneCount = todos.length - pendingCount;
  const overdueCount = todos.filter((item) => isOverdue(item)).length;
  const todayDueCount = todos.filter(
    (item) => !item.done && dueBucket(item.dueAt) === "today",
  ).length;
  const allTags = useMemo(() => collectTags(todos), [todos]);

  const now = Date.now();
  const todayStart = startOfDay(now);
  const anchor = selectedDate ?? now;
  const dateLabel = formatDateLabel(anchor);
  const weekdayLabel = weekdayShort(anchor);

  const dayTodos = useMemo(
    () =>
      selectedDate === null
        ? []
        : todos.filter(
            (item) =>
              item.dueAt !== null && startOfDay(item.dueAt) === selectedDate,
          ),
    [todos, selectedDate],
  );
  const dayPending = dayTodos.filter((item) => !item.done).length;
  const dayDone = dayTodos.length - dayPending;

  const meterDone = selectedDate !== null ? dayDone : doneCount;
  const meterTotal = selectedDate !== null ? dayTodos.length : todos.length;
  const progress =
    meterTotal === 0 ? 0 : Math.round((meterDone / meterTotal) * 100);
  const meterLabel = selectedDate !== null ? "当日进度" : "完成进度";

  const summary = (() => {
    if (selectedDate !== null) {
      return dayTodos.length === 0
        ? "这一天还没有安排。"
        : `这一天有 ${dayPending} 件待办，${dayDone} 件已完成。`;
    }
    if (filter === "done") {
      return doneCount > 0 ? `已完成 ${doneCount} 件。` : "还没有完成的事项。";
    }
    if (pendingCount === 0) {
      return todos.length === 0
        ? "清单是空的，写下一件要做的事。"
        : "所有事情都处理完了。";
    }
    if (overdueCount > 0) {
      return `${pendingCount} 件待处理，${overdueCount} 件已逾期。`;
    }
    if (todayDueCount > 0) {
      return `${pendingCount} 件待处理，${todayDueCount} 件安排在今天。`;
    }
    return `${pendingCount} 件待处理。`;
  })();

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return todos.filter((item) => {
      if (filter === "pending" && item.done) return false;
      if (filter === "done" && !item.done) return false;

      if (
        selectedDate !== null &&
        (item.dueAt === null || startOfDay(item.dueAt) !== selectedDate)
      ) {
        return false;
      }

      if (activeTags.length > 0) {
        const keys = item.tags.map((tag) => tag.toLowerCase());
        if (!activeTags.some((tag) => keys.includes(tag.toLowerCase()))) {
          return false;
        }
      }

      if (!keyword) return true;
      return [item.title, item.note, ...item.tags]
        .join("\n")
        .toLowerCase()
        .includes(keyword);
    });
  }, [todos, filter, query, activeTags, selectedDate]);

  const pendingGroups = useMemo(() => {
    if (filter === "done" || selectedDate !== null) return [];
    if (filter === "all") {
      // 「全部」里已完成条目沉到各分组末尾，避免和未完成条目交错
      const pendingItems = sortTodos(
        visible.filter((item) => !item.done),
        sort,
      );
      const doneItems = visible
        .filter((item) => item.done)
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
      return groupTodos([...pendingItems, ...doneItems]);
    }
    return groupTodos(sortTodos(visible, sort));
  }, [visible, filter, sort, selectedDate]);

  /** 选中某天时，左侧只渲染这一天的条目 */
  const dayList = useMemo(() => {
    if (selectedDate === null) return [];
    if (filter === "done") {
      return [...visible].sort(
        (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0),
      );
    }
    if (filter === "all") {
      const pendingItems = sortTodos(
        visible.filter((item) => !item.done),
        sort,
      );
      const doneItems = visible
        .filter((item) => item.done)
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
      return [...pendingItems, ...doneItems];
    }
    return sortTodos(visible, sort);
  }, [selectedDate, visible, filter, sort]);

  const doneList = useMemo(
    () =>
      filter === "done"
        ? [...visible].sort(
            (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0),
          )
        : [],
    [visible, filter],
  );

  const patchTodo = (updated: TodoItem) => {
    setData((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item)),
    );
  };

  const toggleTodo = async (todo: TodoItem) => {
    try {
      const updated = await ipc.toggleTodo(todo.id, !todo.done);
      if (updated) patchTodo(updated);
    } catch (err) {
      toast.error(toMessage(err), 5000);
    }
  };

  const removeTodo = async (todo: TodoItem) => {
    try {
      await ipc.deleteTodo(todo.id);
      setData((prev) => prev.filter((item) => item.id !== todo.id));
      toast.success("待办已删除");
    } catch (err) {
      toast.error(toMessage(err), 5000);
    }
  };

  const clearCompleted = async () => {
    const confirmed = await confirmDialog({
      title: `清除 ${doneCount} 条已完成待办？`,
      message: "清除后不可恢复，完成情况统计也会随之减少。",
      confirmLabel: "清除",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      const count = await ipc.clearCompletedTodos();
      setData((prev) => prev.filter((item) => !item.done));
      toast.success(`已清除 ${count} 条待办`);
    } catch (err) {
      toast.error(toMessage(err), 5000);
    }
  };

  const createFromComposer = async (draft: TodoDraft) => {
    const created = await ipc.createTodo(draft);
    setData((prev) => [created, ...prev]);
  };

  const submitEditing = async (draft: TodoDraft) => {
    if (editing === "new") {
      const created = await ipc.createTodo(draft);
      setData((prev) => [created, ...prev]);
      toast.success("待办已创建");
    } else if (editing) {
      const updated = await ipc.updateTodo(editing.id, draft);
      if (updated) {
        patchTodo(updated);
        toast.success("待办已保存");
      }
    }
    setEditing(null);
  };

  const toggleTagFilter = (tag: string) => {
    setActiveTags((prev) =>
      prev.includes(tag)
        ? prev.filter((item) => item !== tag)
        : [...prev, tag],
    );
  };

  const resetDrag = () => {
    setDraggingId(null);
    setDropTarget(null);
  };

  /** 同组：日视图按具体日期，普通视图按截止时间分组 */
  const isSameGroup = (a: TodoItem, b: TodoItem) =>
    selectedDate !== null
      ? a.dueAt !== null &&
        b.dueAt !== null &&
        startOfDay(a.dueAt) === startOfDay(b.dueAt)
      : dueBucket(a.dueAt) === dueBucket(b.dueAt);

  const handleDragOver = (targetId: string, position: DragPosition) => {
    if (!draggingId || targetId === draggingId) return;
    const dragged = todos.find((item) => item.id === draggingId);
    const target = todos.find((item) => item.id === targetId);
    if (!dragged || !target || dragged.done || target.done) return;
    // 跨组拖动会改变分组语义，直接不显示落点
    if (!isSameGroup(dragged, target)) {
      setDropTarget(null);
      return;
    }
    setDropTarget((prev) =>
      prev && prev.id === targetId && prev.position === position
        ? prev
        : { id: targetId, position },
    );
  };

  const handleDrop = async (targetId: string, position: DragPosition) => {
    const draggedId = draggingId;
    resetDrag();
    if (!draggedId || draggedId === targetId || sort !== "manual") return;

    const dragged = todos.find((item) => item.id === draggedId);
    const target = todos.find((item) => item.id === targetId);
    if (!dragged || !target || dragged.done || target.done) return;

    if (!isSameGroup(dragged, target)) return;

    // 只重排同组内的 id；组与组之间的 sort_order 互不干扰
    const ids = sortTodos(
      todos.filter((item) => !item.done && isSameGroup(item, target)),
      "manual",
    ).map((item) => item.id);

    const from = ids.indexOf(draggedId);
    if (from < 0) return;
    ids.splice(from, 1);

    let to = ids.indexOf(targetId);
    if (to < 0) return;
    if (position === "after") to += 1;
    ids.splice(to, 0, draggedId);

    setData((prev) =>
      prev.map((item) => {
        const index = ids.indexOf(item.id);
        return index >= 0 ? { ...item, sortOrder: index } : item;
      }),
    );

    try {
      await ipc.reorderTodos(ids);
    } catch (err) {
      toast.error(toMessage(err), 5000);
      reload();
    }
  };

  const renderRow = (todo: TodoItem, manualSort: boolean) => (
    <TodoRow
      key={todo.id}
      todo={todo}
      manualSort={manualSort}
      dragActive={manualSort && draggingId !== null}
      dragging={draggingId === todo.id}
      dropPosition={dropTarget?.id === todo.id ? dropTarget.position : null}
      hideDue={selectedDate !== null}
      onToggle={(item) => void toggleTodo(item)}
      onEdit={(item) => setEditing(item)}
      onDelete={(item) => void removeTodo(item)}
      onTagClick={toggleTagFilter}
      onDragStart={(id) => {
        setDraggingId(id);
        setDropTarget(null);
      }}
      onDragOver={handleDragOver}
      onDrop={(id, position) => void handleDrop(id, position)}
      onDragEnd={resetDrag}
    />
  );

  const tabCount = (id: TodoFilter) => {
    if (selectedDate !== null) {
      if (id === "pending") return dayPending;
      if (id === "done") return dayDone;
      return dayTodos.length;
    }
    return id === "pending"
      ? pendingCount
      : id === "done"
        ? doneCount
        : todos.length;
  };

  const emptyTitle = query.trim()
    ? `没有找到「${query.trim()}」`
    : activeTags.length > 0
      ? "没有匹配的待办"
      : filter === "done"
        ? selectedDate !== null
          ? "这一天还没有完成的事项"
          : "还没有完成的事项"
        : selectedDate !== null
          ? "这一天还没有任务"
          : "清单是空的";
  const emptyHint =
    query.trim() || activeTags.length > 0
      ? "换个关键词，或清除筛选后再试。"
      : filter === "done"
        ? selectedDate !== null
          ? "完成这一天的一条待办后，它会出现在这里。"
          : "完成一条待办后，它会出现在这里。"
        : selectedDate !== null
          ? "在下面记一件事，回车即可加到这一天。"
          : "在上面写下一件要做的事，回车即可保存。";

  return (
    <Page>
      <PageHeader
        title="待办事项"
        icon={<ListTodo className="h-4 w-4" />}
        count={pendingCount}
        countSuffix=" 件待办"
        actions={
          <>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="搜索待办"
            />
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => setEditing("new")}
            >
              新建
            </Button>
          </>
        }
      />

      <PageBody>
        <div className="mx-auto w-full max-w-[1120px]">
          <div className="grid grid-cols-1 gap-6 min-[1080px]:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0">
              {/* 概览：日期主视觉 + 摘要 + 进度 */}
              <section className="relative overflow-hidden rounded-2xl border border-border/70 bg-surface-2/40 p-5">
                {/* 强调色渐变：整卡一层斜向洗色，右上角主光、左下角补光，
                    顶部再加一道细高光，避免大块表面显得平 */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/20 via-accent/[0.05] to-transparent"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-accent/25 blur-3xl"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute -bottom-24 left-1/4 h-56 w-56 rounded-full bg-accent/10 blur-3xl"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent"
                />
                <div className="relative flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                      <h2 className="text-hero font-semibold tracking-tight text-text">
                        {dateLabel}
                      </h2>
                      <span className="rounded-full bg-surface-hover px-2 py-0.5 text-caption font-medium text-text-secondary">
                        {weekdayLabel}
                      </span>
                      {selectedDate !== null && (
                        <button
                          type="button"
                          onClick={() => setSelectedDate(null)}
                          className="text-caption text-accent transition-colors hover:text-accent-hover"
                        >
                          回到全部
                        </button>
                      )}
                    </div>
                    <p className="mt-2 max-w-md text-body leading-relaxed text-text-secondary">
                      {summary}
                    </p>
                  </div>

                  {meterTotal > 0 && (
                    <div className="hidden w-44 shrink-0 sm:block">
                      <div className="flex items-baseline justify-between">
                        <span className="text-caption text-text-muted">
                          {meterLabel}
                        </span>
                        <span className="text-meta font-semibold tabular-nums text-text">
                          {progress}%
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-hover">
                        <div
                          className="h-full rounded-full bg-[var(--c-progress-fill)] transition-[width] duration-500 ease-out motion-reduce:transition-none"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <div className="mt-1.5 text-caption tabular-nums text-text-muted">
                        {meterDone} / {meterTotal} 件已完成
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* 视图切换与排序 */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <SegmentedTabs
                  options={VIEW_TABS.map((tab) => ({
                    id: tab.id,
                    label: tab.label,
                    count: tabCount(tab.id),
                  }))}
                  value={filter}
                  onChange={setFilter}
                />

                <div className="flex items-center gap-2">
                  {filter === "done" ? (
                    doneCount > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        onClick={() => void clearCompleted()}
                      >
                        清除已完成
                      </Button>
                    )
                  ) : (
                    <div className="ui-ring flex h-8 items-center gap-1.5 rounded-full bg-input-bg px-3">
                      <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                      <Select
                        value={sort}
                        onChange={(value) => setSort(value as TodoSort)}
                        options={SORT_OPTIONS}
                        className="text-meta text-text-secondary"
                        minMenuWidth={160}
                        aria-label="排序方式"
                      />
                    </div>
                  )}
                </div>
              </div>

              {loading ? (
                <LoadingState text="正在加载待办" />
              ) : error ? (
                <ErrorState message={error} onRetry={reload} />
              ) : (
                <>
                  {/* 添加行 */}
                  {filter !== "done" && (
                    <div className="mt-4">
                      <TodoComposer
                        suggestions={allTags}
                        defaultDueAt={selectedDate}
                        onCreate={createFromComposer}
                      />
                    </div>
                  )}

                  {/* 标签筛选 */}
                  {allTags.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <span className="mr-1 inline-flex items-center gap-1 text-caption text-text-muted">
                        <Tag className="h-3 w-3" />
                        标签
                      </span>
                      {allTags.map((tag) => {
                        const active = activeTags.includes(tag);
                        return (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => toggleTagFilter(tag)}
                            className={`rounded-full border px-2.5 py-0.5 text-caption transition-colors ${
                              active
                                ? "border-accent/30 bg-accent-soft font-medium text-accent"
                                : "border-border/60 bg-surface-2/40 text-text-muted hover:border-border hover:text-text"
                            }`}
                          >
                            #{tag}
                          </button>
                        );
                      })}
                      {activeTags.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setActiveTags([])}
                          className="ml-1 text-caption text-text-muted underline underline-offset-2 transition-colors hover:text-text"
                        >
                          清除
                        </button>
                      )}
                    </div>
                  )}

                  {visible.length === 0 ? (
                    <div className="mt-4 rounded-xl border border-dashed border-border bg-surface-2/30">
                      <EmptyState
                        icon={<Inbox />}
                        title={emptyTitle}
                        description={emptyHint}
                        action={
                          (query.trim() ||
                            activeTags.length > 0 ||
                            selectedDate !== null) && (
                            <div className="flex items-center justify-center gap-4">
                              {(query.trim() || activeTags.length > 0) && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setQuery("");
                                    setActiveTags([]);
                                  }}
                                  className="text-meta text-accent hover:underline"
                                >
                                  清除筛选
                                </button>
                              )}
                              {selectedDate !== null && (
                                <button
                                  type="button"
                                  onClick={() => setSelectedDate(null)}
                                  className="text-meta text-accent hover:underline"
                                >
                                  回到全部
                                </button>
                              )}
                            </div>
                          )
                        }
                      />
                    </div>
                  ) : selectedDate !== null ? (
                    <div className="mt-4">
                      <TodoGroupCard
                        label={
                          selectedDate === todayStart ? "今天" : weekdayLabel
                        }
                        tone="today"
                        count={dayList.length}
                      >
                        {dayList.map((todo) =>
                          renderRow(todo, sort === "manual"),
                        )}
                      </TodoGroupCard>
                    </div>
                  ) : filter === "done" ? (
                    <div className="mt-4">
                      <TodoGroupCard
                        label="已完成"
                        tone="done"
                        count={doneCount}
                      >
                        {doneList.map((todo) => renderRow(todo, false))}
                      </TodoGroupCard>
                    </div>
                  ) : (
                    <div className="mt-4 space-y-3">
                      {pendingGroups.map((group) => (
                        <TodoGroupCard
                          key={group.bucket}
                          label={group.label}
                          tone={group.bucket}
                          count={group.items.length}
                        >
                          {group.items.map((todo) =>
                            renderRow(todo, sort === "manual"),
                          )}
                        </TodoGroupCard>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <aside className="min-w-0 space-y-4">
              {!loading && !error && (
                <>
                  <TodoCalendar
                    todos={todos}
                    selectedDate={selectedDate}
                    onSelectDate={setSelectedDate}
                  />
                  <TodoStats todos={todos} />
                </>
              )}
            </aside>
          </div>
        </div>
      </PageBody>

      <TodoEditorDialog
        open={editing !== null}
        todo={editing === "new" ? null : editing}
        suggestions={allTags}
        defaultDueAt={selectedDate}
        onClose={() => setEditing(null)}
        onSubmit={submitEditing}
      />
    </Page>
  );
}

/**
 * 分组卡片：表头（状态点 / 名称 / 计数）+ 条目列表。
 * 条目之间由 ul 的 divide 画细线，最后一条不再多一条边。
 */
function TodoGroupCard({
  label,
  tone,
  count,
  children,
}: {
  label: string;
  tone: DueBucket | "done";
  count: number;
  children: ReactNode;
}) {
  const dot =
    tone === "done" ? "bg-success" : GROUP_TONE[tone as DueBucket];
  const labelTone =
    tone === "overdue"
      ? "text-error"
      : tone === "done"
        ? "text-success"
        : "text-text-secondary";

  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-surface-2/40 shadow-[var(--c-shadow-sm)]">
      <header className="flex items-center gap-2 border-b border-border/60 bg-surface-hover/35 px-4 py-2.5">
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <h3 className={`text-meta font-semibold ${labelTone}`}>{label}</h3>
        <span className="rounded-full bg-surface-hover px-1.5 text-caption tabular-nums text-text-muted">
          {count}
        </span>
      </header>
      <ul className="divide-y divide-border/50">{children}</ul>
    </section>
  );
}
