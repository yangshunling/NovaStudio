/**
 * 触发器页
 *
 * 触发器是「定时启动工作流」的独立配置：在这里统一创建 / 编辑，
 * 再在工作流卡片的右键菜单里绑定。一个触发器可以驱动多条工作流，
 * 一条工作流也可以被多个触发器驱动。
 *
 * 页面只负责定义与状态展示；到点启动的逻辑在主进程 trigger-scheduler。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlarmClock,
  Loader2,
  Pencil,
  Plus,
  Repeat,
  Trash2,
  Zap,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toast } from "../../stores/toast";
import { Modal, ModalHeader } from "../ui/Modal";
import { Field, FORM_INPUT_CLASS } from "../ui/Field";
import { Toggle } from "../employees/ui";
import {
  describeTriggerSchedule,
  sortWeekdays,
  TRIGGER_INTERVAL_MAX,
  TRIGGER_INTERVAL_MIN,
  TRIGGER_WEEKDAYS,
} from "@shared/trigger-schedule";
import type {
  Workflow,
  WorkflowTrigger,
  WorkflowTriggerBinding,
  WorkflowTriggerDraft,
  WorkflowTriggerSchedule,
} from "@shared/types";

type ScheduleKind = WorkflowTriggerSchedule["kind"];

const KIND_OPTIONS: ReadonlyArray<{
  kind: ScheduleKind;
  label: string;
  hint: string;
}> = [
  { kind: "daily", label: "每天", hint: "每天固定时刻触发一次" },
  { kind: "weekly", label: "每周", hint: "每周选定的星期触发" },
  { kind: "interval", label: "每隔", hint: "按固定间隔循环触发" },
];

/** 间隔的常用预设（分钟） */
const INTERVAL_PRESETS = [15, 30, 60, 180, 720];

export function TriggersView() {
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [bindings, setBindings] = useState<WorkflowTriggerBinding[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** null 表示弹框关闭；"new" 表示新建；否则为正在编辑的触发器 */
  const [editing, setEditing] = useState<WorkflowTrigger | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const [triggerList, bindingList, workflowList] = await Promise.all([
        ipc.listTriggers(),
        ipc.listTriggerBindings(),
        ipc.listWorkflows(),
      ]);
      setTriggers(triggerList);
      setBindings(bindingList);
      setWorkflows(workflowList);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 调度器触发后会推送新的 lastFiredAt / nextFireAt，直接就地更新卡片
  useEffect(
    () =>
      ipc.on.triggersUpdated((updated) => {
        setTriggers((current) => {
          if (!current.some((item) => item.id === updated.id)) {
            return [updated, ...current];
          }
          return current.map((item) =>
            item.id === updated.id ? updated : item,
          );
        });
      }),
    [],
  );

  /** triggerId → 已绑定的工作流名称 */
  const boundWorkflowNames = useMemo(() => {
    const nameById = new Map(workflows.map((item) => [item.id, item.name]));
    const map = new Map<string, string[]>();
    for (const binding of bindings) {
      const name = nameById.get(binding.workflowId);
      if (!name) continue;
      const list = map.get(binding.triggerId) ?? [];
      list.push(name);
      map.set(binding.triggerId, list);
    }
    return map;
  }, [bindings, workflows]);

  const saveTrigger = async (draft: WorkflowTriggerDraft) => {
    if (editing === "new") {
      const created = await ipc.createTrigger(draft);
      setTriggers((current) => [created, ...current]);
      toast.success("触发器已创建");
    } else if (editing) {
      const updated = await ipc.updateTrigger(editing.id, draft);
      if (updated) {
        setTriggers((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
        toast.success("触发器已保存");
      }
    }
    setEditing(null);
  };

  const toggleTrigger = async (trigger: WorkflowTrigger, enabled: boolean) => {
    try {
      const updated = await ipc.updateTrigger(trigger.id, {
        title: trigger.title,
        description: trigger.description,
        schedule: trigger.schedule,
        enabled,
      });
      if (!updated) return;
      setTriggers((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      toast.success(
        enabled ? `已启用「${trigger.title}」` : `已停用「${trigger.title}」`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 5000);
    }
  };

  const deleteTrigger = async (trigger: WorkflowTrigger) => {
    const boundCount = boundWorkflowNames.get(trigger.id)?.length ?? 0;
    const confirmed = window.confirm(
      [
        `删除触发器「${trigger.title}」？`,
        "",
        boundCount > 0
          ? `它绑定了 ${boundCount} 条工作流，删除后将不再定时启动这些工作流（工作流本身不受影响）。`
          : "该触发器尚未绑定任何工作流。",
        "此操作不可恢复。",
      ].join("\n"),
    );
    if (!confirmed) return;

    try {
      await ipc.deleteTrigger(trigger.id);
      setTriggers((current) => current.filter((item) => item.id !== trigger.id));
      setBindings((current) =>
        current.filter((item) => item.triggerId !== trigger.id),
      );
      toast.success(`触发器「${trigger.title}」已删除`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 5000);
    }
  };

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden rounded-xl">
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-3 border-b border-border px-card">
          <div className="flex min-w-0 items-center gap-2">
            <span className="ui-serif text-title font-semibold tracking-wide text-text-secondary">
              触发器
            </span>
            <span className="rounded-full bg-surface-hover px-2 py-0.5 text-meta font-mono text-text-muted">
              {triggers.length} 个
            </span>
          </div>

          <button
            type="button"
            onClick={() => setEditing("new")}
            className="ui-btn-primary flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95"
          >
            <Plus className="h-4 w-4" />
            新建触发器
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-section">
          {loading ? (
            <div className="flex h-60 items-center justify-center gap-2 text-body text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载触发器
            </div>
          ) : error ? (
            <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
              <p className="text-body text-error">{error}</p>
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  void load();
                }}
                className="ui-btn-ghost rounded-lg px-3 py-2 text-body"
              >
                重新加载
              </button>
            </div>
          ) : triggers.length === 0 ? (
            <EmptyTriggers onCreate={() => setEditing("new")} />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {triggers.map((trigger) => (
                <TriggerCard
                  key={trigger.id}
                  trigger={trigger}
                  boundWorkflows={boundWorkflowNames.get(trigger.id) ?? []}
                  onToggle={(enabled) => void toggleTrigger(trigger, enabled)}
                  onEdit={() => setEditing(trigger)}
                  onDelete={() => void deleteTrigger(trigger)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <TriggerDialog
        open={editing !== null}
        trigger={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSubmit={saveTrigger}
      />
    </main>
  );
}

// ============================================================================
// 卡片
// ============================================================================

function TriggerCard({
  trigger,
  boundWorkflows,
  onToggle,
  onEdit,
  onDelete,
}: {
  trigger: WorkflowTrigger;
  boundWorkflows: string[];
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-surface-2/60 p-card shadow-[var(--c-shadow-sm)] transition-colors hover:border-border-strong hover:bg-surface-2/85">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
          <Zap className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-heading font-semibold text-text">
            {trigger.title}
          </h3>
          <p className="mt-1 line-clamp-2 text-body leading-relaxed text-text-muted">
            {trigger.description || "暂无说明"}
          </p>
        </div>
        <Toggle
          checked={trigger.enabled}
          onChange={onToggle}
          label={`启用触发器 ${trigger.title}`}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-meta">
        <span className="flex items-center gap-1 rounded-full bg-surface-hover px-2.5 py-1 text-text-secondary">
          <AlarmClock className="h-3.5 w-3.5 text-accent" />
          {describeTriggerSchedule(trigger.schedule)}
        </span>
        <span
          className={`rounded-full px-2.5 py-1 ${
            trigger.enabled
              ? "bg-surface-hover text-text-muted"
              : "bg-surface-hover text-text-muted opacity-70"
          }`}
        >
          {trigger.enabled
            ? `下次 ${formatFireTime(trigger.nextFireAt) ?? "待计算"}`
            : "已停用"}
        </span>
        {trigger.lastFiredAt && (
          <span className="text-caption text-text-muted">
            上次触发 {formatFireTime(trigger.lastFiredAt)}
          </span>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
        <p
          className="min-w-0 truncate text-meta text-text-muted"
          title={boundWorkflows.join("、")}
        >
          {boundWorkflows.length > 0
            ? `已绑定 ${boundWorkflows.length} 条工作流：${boundWorkflows.join("、")}`
            : "未绑定工作流（在工作流右键菜单中绑定）"}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            title="编辑触发器"
            className="ui-btn-ghost flex h-7 items-center gap-1 rounded-full px-2.5 text-meta font-medium active:scale-95"
          >
            <Pencil className="h-3.5 w-3.5" />
            编辑
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="删除触发器"
            className="flex h-7 items-center gap-1 rounded-full px-2.5 text-meta font-medium text-error transition-colors hover:bg-error-bg active:scale-95"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 编辑弹框
// ============================================================================

function TriggerDialog({
  open,
  trigger,
  onClose,
  onSubmit,
}: {
  open: boolean;
  trigger: WorkflowTrigger | null;
  onClose: () => void;
  onSubmit: (draft: WorkflowTriggerDraft) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("daily");
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [minutes, setMinutes] = useState(30);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  // 每次打开时用当前触发器（或默认值）重置表单
  useEffect(() => {
    if (!open) return;
    if (!trigger) {
      setTitle("");
      setDescription("");
      setKind("daily");
      setTime("09:00");
      setWeekdays([1, 2, 3, 4, 5]);
      setMinutes(30);
      setEnabled(true);
      return;
    }
    // 先回到默认值，再按当前规则覆盖；避免切换编辑对象时残留上一次的选项
    setTitle(trigger.title);
    setDescription(trigger.description);
    setKind(trigger.schedule.kind);
    setTime(trigger.schedule.kind === "interval" ? "09:00" : trigger.schedule.time);
    setWeekdays(
      trigger.schedule.kind === "weekly"
        ? trigger.schedule.weekdays
        : [1, 2, 3, 4, 5],
    );
    setMinutes(
      trigger.schedule.kind === "interval" ? trigger.schedule.minutes : 30,
    );
    setEnabled(trigger.enabled);
  }, [open, trigger]);

  const schedule: WorkflowTriggerSchedule = useMemo(() => {
    if (kind === "interval") {
      return {
        kind: "interval",
        minutes: Math.min(
          TRIGGER_INTERVAL_MAX,
          Math.max(TRIGGER_INTERVAL_MIN, Math.round(minutes) || 1),
        ),
      };
    }
    if (kind === "weekly") {
      return {
        kind: "weekly",
        time: time || "09:00",
        weekdays: sortWeekdays(weekdays.length > 0 ? weekdays : [1]),
      };
    }
    return { kind: "daily", time: time || "09:00" };
  }, [kind, time, weekdays, minutes]);

  const toggleWeekday = (day: number) => {
    setWeekdays((current) =>
      current.includes(day)
        ? current.filter((item) => item !== day)
        : [...current, day],
    );
  };

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim(),
        schedule,
        enabled,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 5000);
    } finally {
      setBusy(false);
    }
  };

  const kindHint =
    KIND_OPTIONS.find((item) => item.kind === kind)?.hint ?? "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      widthClass="w-[500px] max-w-[92vw]"
    >
      <div className="p-card">
        <ModalHeader
          title={trigger ? "编辑触发器" : "新建触发器"}
          onClose={onClose}
        />

        <div className="space-y-3">
          <Field label="标题" required>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              placeholder="例如：每日站会汇总"
              className={FORM_INPUT_CLASS}
            />
          </Field>

          <Field label="描述" hint="说明这条触发器在什么场景下使用，便于团队辨认。">
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder="例如：每天上班前汇总昨天的待办与风险"
              className={`${FORM_INPUT_CLASS} resize-none`}
            />
          </Field>

          <div>
            <div className="mb-1.5 text-meta font-medium text-text-secondary">
              定时方式
            </div>
            <div className="flex gap-1.5">
              {KIND_OPTIONS.map((option) => {
                const active = kind === option.kind;
                return (
                  <button
                    key={option.kind}
                    type="button"
                    onClick={() => setKind(option.kind)}
                    className={`flex-1 rounded-lg px-3 py-2 text-body font-medium transition-colors ${
                      active
                        ? "bg-accent-soft text-accent shadow-[var(--c-shadow-sm)]"
                        : "bg-surface-2/60 text-text-secondary hover:bg-surface-hover hover:text-text"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-meta text-text-muted">{kindHint}</p>
          </div>

          {kind === "interval" ? (
            <Field
              label="每隔多少分钟"
              hint={`范围 ${TRIGGER_INTERVAL_MIN} - ${TRIGGER_INTERVAL_MAX} 分钟；应用运行期间按此间隔循环触发。`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={TRIGGER_INTERVAL_MIN}
                  max={TRIGGER_INTERVAL_MAX}
                  value={minutes}
                  onChange={(event) =>
                    setMinutes(Number(event.target.value) || 0)
                  }
                  className="ui-ring w-32 rounded-lg bg-input-bg px-inset py-inset text-body text-text outline-none transition-colors focus:border-input-border-focus"
                />
                <span className="text-body text-text-muted">分钟</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {INTERVAL_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setMinutes(preset)}
                    className={`rounded-full px-2.5 py-1 text-meta transition-colors ${
                      minutes === preset
                        ? "bg-accent-soft font-medium text-accent"
                        : "bg-surface-2/60 text-text-secondary hover:bg-surface-hover hover:text-text"
                    }`}
                  >
                    {preset >= 60 ? `${preset / 60} 小时` : `${preset} 分钟`}
                  </button>
                ))}
              </div>
            </Field>
          ) : (
            <>
              {kind === "weekly" && (
                <div>
                  <div className="mb-1.5 text-meta font-medium text-text-secondary">
                    星期
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {TRIGGER_WEEKDAYS.map((day) => {
                      const active = weekdays.includes(day.value);
                      return (
                        <button
                          key={day.value}
                          type="button"
                          onClick={() => toggleWeekday(day.value)}
                          className={`rounded-full px-3 py-1.5 text-meta transition-colors ${
                            active
                              ? "bg-accent-soft font-medium text-accent"
                              : "bg-surface-2/60 text-text-secondary hover:bg-surface-hover hover:text-text"
                          }`}
                        >
                          {day.label}
                        </button>
                      );
                    })}
                  </div>
                  {weekdays.length === 0 && (
                    <p className="mt-1 text-meta text-error">
                      至少选择一天
                    </p>
                  )}
                </div>
              )}

              <Field label="触发时刻" hint="使用本机时间；应用需保持运行。">
                <input
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  className="ui-ring w-36 rounded-lg bg-input-bg px-inset py-inset text-body text-text outline-none transition-colors focus:border-input-border-focus"
                />
              </Field>
            </>
          )}

          <div className="flex items-center justify-between rounded-lg bg-surface-2/60 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-body font-medium text-text">启用触发器</p>
              <p className="mt-0.5 text-meta text-text-muted">
                停用后保留配置，但不会自动启动工作流
              </p>
            </div>
            <Toggle
              checked={enabled}
              onChange={setEnabled}
              label="启用触发器"
            />
          </div>

          <div className="flex items-center gap-1.5 rounded-lg bg-accent-soft/40 px-3 py-2 text-meta text-text-secondary">
            <Repeat className="h-3.5 w-3.5 shrink-0 text-accent" />
            将按「{describeTriggerSchedule(schedule)}」触发
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="ui-btn-ghost h-9 rounded-full px-4 text-body font-medium active:scale-95"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!title.trim() || busy || (kind === "weekly" && weekdays.length === 0)}
            className="ui-btn-primary flex h-9 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================================
// 空态与格式化
// ============================================================================

function EmptyTriggers({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-24 text-center text-text-muted">
      <div className="ui-btn-round flex h-16 w-16 items-center justify-center rounded-2xl">
        <Zap className="h-6 w-6" />
      </div>
      <h2 className="ui-serif text-heading font-semibold text-text-secondary">
        让工作流按时自己跑起来
      </h2>
      <p className="text-body leading-relaxed">
        先创建一个触发器，设置每天几点、每周哪几天或每隔多久触发；
        再在工作流卡片的右键菜单里把触发器绑上去。
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="ui-btn-primary mt-2 flex h-8 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95"
      >
        <Plus className="h-4 w-4" />
        新建触发器
      </button>
    </div>
  );
}

/** 把时间戳格式化为「今天 / 明天 HH:mm」或「MM-DD HH:mm」 */
export function formatFireTime(timestamp: number | null): string | null {
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  const now = new Date();
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;

  if (date.toDateString() === now.toDateString()) return `今天 ${clock}`;

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `明天 ${clock}`;

  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")} ${clock}`;
}
