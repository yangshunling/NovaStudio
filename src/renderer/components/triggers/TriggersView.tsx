/**
 * 触发器页
 *
 * 触发器是「定时启动工作流」的独立配置：在这里统一创建 / 编辑，
 * 再在工作流卡片的右键菜单里绑定。一个触发器可以驱动多条工作流，
 * 一条工作流也可以被多个触发器驱动。
 *
 * 页面只负责定义与状态展示；到点启动的逻辑在主进程 trigger-scheduler。
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlarmClock,
  Clock,
  Pencil,
  Play,
  Plus,
  Repeat,
  Trash2,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { formatHm, isSameDay, pad2 } from "@shared/time";
import { useLoad } from "../../hooks/useLoad";
import {
  EmptyBlock,
  EmptyState,
  ErrorState,
  LoadingState,
} from "../ui/EmptyState";
import { Page, PageBody, PageHeader } from "../ui/Page";
import { OptionChips } from "../ui/OptionChips";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import { Dialog, DialogActions } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, TextArea, TextInput } from "../ui/Field";
import { Toggle } from "../ui/Toggle";
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
  // 三份数据一次拉齐：触发器是主体，bindings/workflows 用于展示「绑定了哪些工作流」
  const { data, loading, error, reload, setData } = useLoad(
    async () => {
      const [triggers, bindings, workflows] = await Promise.all([
        ipc.listTriggers(),
        ipc.listTriggerBindings(),
        ipc.listWorkflows(),
      ]);
      return { triggers, bindings, workflows };
    },
    { triggers: [] as WorkflowTrigger[], bindings: [] as WorkflowTriggerBinding[], workflows: [] as Workflow[] },
  );
  const { triggers, bindings, workflows } = data;
  /** 只更新三元组中的某一项，保持 useLoad 单一数据源 */
  const patch = <K extends keyof typeof data>(
    key: K,
    next: typeof data[K] | ((prev: typeof data[K]) => typeof data[K]),
  ) =>
    setData((prev) => ({
      ...prev,
      [key]: typeof next === "function" ? (next as (p: typeof data[K]) => typeof data[K])(prev[key]) : next,
    }));
  const setTriggers = (next: Parameters<typeof patch<"triggers">>[1]) => patch("triggers", next);
  const setBindings = (next: Parameters<typeof patch<"bindings">>[1]) => patch("bindings", next);

  /** null 表示弹框关闭；"new" 表示新建；否则为正在编辑的触发器 */
  const [editing, setEditing] = useState<WorkflowTrigger | "new" | null>(null);

  /** 触发器 → 绑定工作流 */
  const [bindingTarget, setBindingTarget] = useState<WorkflowTrigger | null>(null);
  const [bindingWorkflowIds, setBindingWorkflowIds] = useState<string[]>([]);
  const [bindingSaving, setBindingSaving] = useState(false);

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
      toast.error(toMessage(err), 5000);
    }
  };

  const deleteTrigger = async (trigger: WorkflowTrigger) => {
    const boundCount = boundWorkflowNames.get(trigger.id)?.length ?? 0;
    const confirmed = await confirmDialog({
      title: `删除触发器「${trigger.title}」？`,
      message: [
        boundCount > 0
          ? `它绑定了 ${boundCount} 条工作流，删除后将不再定时启动这些工作流（工作流本身不受影响）。`
          : "该触发器尚未绑定任何工作流。",
        "此操作不可恢复。",
      ].join("\n"),
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) return;

    try {
      await ipc.deleteTrigger(trigger.id);
      setTriggers((current) => current.filter((item) => item.id !== trigger.id));
      setBindings((current) =>
        current.filter((item) => item.triggerId !== trigger.id),
      );
      toast.success(`触发器「${trigger.title}」已删除`);
    } catch (err) {
      toast.error(toMessage(err), 5000);
    }
  };

  const openBindings = (trigger: WorkflowTrigger) => {
    setBindingTarget(trigger);
    setBindingWorkflowIds(
      bindings
        .filter((binding) => binding.triggerId === trigger.id)
        .map((binding) => binding.workflowId),
    );
  };

  const toggleBinding = (workflowId: string) => {
    setBindingWorkflowIds((current) =>
      current.includes(workflowId)
        ? current.filter((id) => id !== workflowId)
        : [...current, workflowId],
    );
  };

  /**
   * 绑定接口是按工作流整体替换的，这里把每个工作流的目标集合算好再逐个写回。
   * 只写有变化的工作流，避免无谓的数据库更新。
   */
  const saveBindings = async () => {
    if (!bindingTarget || bindingSaving) return;
    setBindingSaving(true);
    try {
      const target = new Set(bindingWorkflowIds);
      for (const workflow of workflows) {
        const current = bindings
          .filter((binding) => binding.workflowId === workflow.id)
          .map((binding) => binding.triggerId);
        const shouldBind = target.has(workflow.id);
        const bound = current.includes(bindingTarget.id);
        if (shouldBind === bound) continue;
        const next = shouldBind
          ? [...current, bindingTarget.id]
          : current.filter((id) => id !== bindingTarget.id);
        await ipc.setWorkflowTriggers(workflow.id, next);
      }
      setBindings(await ipc.listTriggerBindings());
      toast.success(`已更新「${bindingTarget.title}」的绑定`);
      setBindingTarget(null);
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setBindingSaving(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="触发器"
        count={triggers.length}
        countSuffix=" 个"
        icon={<Zap className="h-4 w-4" />}
        actions={
          <Button
            variant="primary"
            onClick={() => setEditing("new")}
            icon={<Plus className="h-4 w-4" />}
          >
            新建触发器
          </Button>
        }
      />

      <PageBody>
        {loading ? (
          <LoadingState text="正在加载触发器" />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : triggers.length === 0 ? (
          <EmptyTriggers onCreate={() => setEditing("new")} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
            {triggers.map((trigger) => (
              <TriggerCard
                key={trigger.id}
                trigger={trigger}
                workflowNames={boundWorkflowNames.get(trigger.id) ?? []}
                onToggle={(enabled) => void toggleTrigger(trigger, enabled)}
                onBind={() => openBindings(trigger)}
                onEdit={() => setEditing(trigger)}
                onDelete={() => void deleteTrigger(trigger)}
              />
            ))}
          </div>
        )}
      </PageBody>

      <TriggerDialog
        open={editing !== null}
        trigger={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSubmit={saveTrigger}
      />

      {/* 触发器 → 绑定工作流（从触发器侧配置，避免只能去工作流右键菜单找） */}
      <Dialog
        open={bindingTarget !== null}
        onClose={() => setBindingTarget(null)}
        title={bindingTarget ? `绑定工作流 · ${bindingTarget.title}` : "绑定工作流"}
        width="md"
        description="勾选要由这个触发器定时启动的工作流；一个触发器可以驱动多条工作流。"
      >
        {workflows.length === 0 ? (
          <EmptyBlock
            icon={<WorkflowIcon />}
            title="还没有工作流"
            description="先创建一个工作流，再回来绑定。"
          />
        ) : (
          <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-0.5">
            {workflows.map((workflow) => {
              const selected = bindingWorkflowIds.includes(workflow.id);
              return (
                <label
                  key={workflow.id}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
                    selected
                      ? "border-accent/50 bg-selected"
                      : "border-border bg-surface-2/40 hover:bg-surface-hover"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleBinding(workflow.id)}
                    className="h-4 w-4 shrink-0"
                    style={{ accentColor: "var(--c-accent)" }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate ui-type-body font-medium text-text">
                      {workflow.name}
                    </span>
                    {workflow.description && (
                      <span className="mt-0.5 block truncate ui-type-note text-text-muted">
                        {workflow.description}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        <DialogActions>
          <Button onClick={() => setBindingTarget(null)}>取消</Button>
          <Button
            variant="primary"
            onClick={() => void saveBindings()}
            disabled={workflows.length === 0}
            loading={bindingSaving}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </Page>
  );
}

// ============================================================================
// 卡片
// ============================================================================

function TriggerCard({
  trigger,
  workflowNames,
  onToggle,
  onBind,
  onEdit,
  onDelete,
}: {
  trigger: WorkflowTrigger;
  workflowNames: string[];
  onToggle: (enabled: boolean) => void;
  onBind: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const enabled = trigger.enabled;

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-xl border border-border/60 bg-surface-2/40 shadow-[var(--c-shadow-sm)] transition-colors hover:bg-surface-2/55">
      {/* 顶部状态条：启用时按强调色亮起 */}
      <span
        aria-hidden
        className={`absolute inset-x-0 top-0 h-[2px] ${
          enabled ? "bg-accent/70" : "bg-border"
        }`}
      />

      <div className="flex items-start gap-3 p-4">
        <span
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors ${
            enabled
              ? "bg-accent-soft text-accent"
              : "bg-surface-hover text-text-muted"
          }`}
        >
          <Zap className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3
              className={`truncate ui-type-item font-semibold ${
                enabled ? "text-text" : "text-text-secondary"
              }`}
              title={trigger.title}
            >
              {trigger.title}
            </h3>
            <Toggle
              checked={enabled}
              onChange={onToggle}
              label={`启用触发器 ${trigger.title}`}
            />
          </div>
          <p className="mt-1 line-clamp-2 ui-type-note leading-relaxed text-text-muted">
            {trigger.description || "暂无说明"}
          </p>
        </div>
      </div>

      {/* 调度信息：规则 + 下次执行 + 状态 */}
      <div className="mx-4 rounded-lg border border-border/60 bg-surface/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 ui-type-label text-text-secondary">
            <AlarmClock className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="truncate">
              {describeTriggerSchedule(trigger.schedule)}
            </span>
          </span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 ui-type-sub font-medium ${
              enabled
                ? "bg-accent-soft text-accent"
                : "bg-surface-hover text-text-muted"
            }`}
          >
            {enabled ? "启用中" : "已停用"}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-1.5 ui-type-sub text-text-muted">
          <Clock className="h-3 w-3 shrink-0" />
          {enabled
            ? `下次执行 ${formatFireTime(trigger.nextFireAt) ?? "待计算"}`
            : "停用期间不会触发"}
        </div>
      </div>

      {trigger.lastError && (
        <p
          className="mx-4 mt-2 line-clamp-2 break-words rounded-lg bg-error-bg px-2.5 py-1.5 ui-type-note leading-relaxed text-error"
          title={trigger.lastError}
        >
          最近一次触发失败：{trigger.lastError}
        </p>
      )}

      {/* 已绑定的工作流：直接显示在卡片上，不用点开绑定弹窗才能确认 */}
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5 px-4">
        <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        {workflowNames.length > 0 ? (
          <>
            {workflowNames.slice(0, 3).map((name) => (
              <span
                key={name}
                className="max-w-[140px] truncate rounded-full bg-surface-hover px-2 py-0.5 ui-type-sub text-text-secondary"
                title={name}
              >
                {name}
              </span>
            ))}
            {workflowNames.length > 3 && (
              <span className="ui-type-sub text-text-muted">
                +{workflowNames.length - 3}
              </span>
            )}
          </>
        ) : (
          <span className="ui-type-sub text-text-muted">尚未绑定工作流</span>
        )}
      </div>

      <div className="mt-auto px-4 pb-4 pt-3">
        <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
          <span className="min-w-0 truncate ui-type-sub text-text-muted">
            {trigger.lastFiredAt !== null
              ? `上次触发 ${formatFireTime(trigger.lastFiredAt)}`
              : "从未触发"}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="xs"
              onClick={onBind}
              title="绑定工作流"
              icon={<WorkflowIcon className="h-3.5 w-3.5" />}
            >
              绑定
            </Button>
            <Button
              size="xs"
              onClick={onEdit}
              title="编辑触发器"
              icon={<Pencil className="h-3.5 w-3.5" />}
            >
              编辑
            </Button>
            <Button
              size="xs"
              variant="dangerLink"
              onClick={onDelete}
              title="删除触发器"
              icon={<Trash2 className="h-3.5 w-3.5" />}
            >
              删除
            </Button>
          </div>
        </div>
      </div>
    </article>
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
      toast.error(toMessage(err), 5000);
    } finally {
      setBusy(false);
    }
  };

  const kindHint =
    KIND_OPTIONS.find((item) => item.kind === kind)?.hint ?? "";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={trigger ? "编辑触发器" : "新建触发器"}
      width="md"
    >
        <div className="space-y-3">
          <Field label="标题" required>
            <TextInput
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              placeholder="例如：每日站会汇总"
            />
          </Field>

          <Field label="描述" hint="说明这条触发器在什么场景下使用，便于团队辨认。">
            <TextArea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder="例如：每天上班前汇总昨天的待办与风险"
              className="resize-none"
            />
          </Field>

          <div>
            <div className="mb-1.5 ui-type-label text-text-secondary">
              定时方式
            </div>
            <OptionChips
              mode="single"
              variant="rect"
              items={KIND_OPTIONS.map((option) => ({
                id: option.kind,
                label: option.label,
              }))}
              selected={kind}
              onSelect={(id) => setKind(id as ScheduleKind)}
            />
            <p className="mt-1 ui-type-note text-text-muted">{kindHint}</p>
          </div>

          {kind === "interval" ? (
            <Field
              label="每隔多少分钟"
              hint={`范围 ${TRIGGER_INTERVAL_MIN} - ${TRIGGER_INTERVAL_MAX} 分钟；应用运行期间按此间隔循环触发。`}
            >
              <div className="flex items-center gap-2">
                <div className="w-32">
                  <TextInput
                    type="number"
                    min={TRIGGER_INTERVAL_MIN}
                    max={TRIGGER_INTERVAL_MAX}
                    value={minutes}
                    onChange={(event) =>
                      setMinutes(Number(event.target.value) || 0)
                    }
                  />
                </div>
                <span className="ui-type-body text-text-muted">分钟</span>
              </div>
              <OptionChips
                mode="single"
                size="sm"
                className="mt-2"
                items={INTERVAL_PRESETS.map((preset) => ({
                  id: preset,
                  label: preset >= 60 ? `${preset / 60} 小时` : `${preset} 分钟`,
                }))}
                selected={minutes}
                onSelect={(id) => setMinutes(Number(id))}
              />
            </Field>
          ) : (
            <>
              {kind === "weekly" && (
                <div>
                  <div className="mb-1.5 ui-type-label text-text-secondary">
                    星期
                  </div>
                  <OptionChips
                    mode="multi"
                    size="md"
                    items={TRIGGER_WEEKDAYS.map((day) => ({
                      id: day.value,
                      label: day.label,
                    }))}
                    selected={weekdays}
                    onToggle={(id) => toggleWeekday(Number(id))}
                  />
                  {weekdays.length === 0 && (
                    <p className="mt-1 ui-type-note text-error">
                      至少选择一天
                    </p>
                  )}
                </div>
              )}

              <Field label="触发时刻" hint="使用本机时间；应用需保持运行。">
                <div className="w-36">
                  <TextInput
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                  />
                </div>
              </Field>
            </>
          )}

          <div className="flex items-center justify-between rounded-lg bg-surface-2/40 px-3 py-2.5">
            <div className="min-w-0">
              <p className="ui-type-body font-medium text-text">启用触发器</p>
              <p className="mt-0.5 ui-type-note text-text-muted">
                停用后保留配置，但不会自动启动工作流
              </p>
            </div>
            <Toggle
              checked={enabled}
              onChange={setEnabled}
              label="启用触发器"
            />
          </div>

          <div className="flex items-center gap-1.5 rounded-lg bg-accent-soft/40 px-3 py-2 ui-type-note text-text-secondary">
            <Repeat className="h-3.5 w-3.5 shrink-0 text-accent" />
            将按「{describeTriggerSchedule(schedule)}」触发
          </div>
        </div>

        <DialogActions>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!title.trim() || (kind === "weekly" && weekdays.length === 0)}
            loading={busy}
          >
            保存
          </Button>
        </DialogActions>
    </Dialog>
  );
}

// ============================================================================
// 空态与格式化
// ============================================================================

function EmptyTriggers({ onCreate }: { onCreate: () => void }) {
  const steps = [
    {
      icon: AlarmClock,
      title: "设置时间",
      description: "每天、每周或按固定间隔",
    },
    {
      icon: WorkflowIcon,
      title: "绑定工作流",
      description: "一个触发器可驱动多条",
    },
    {
      icon: Play,
      title: "自动运行",
      description: "应用保持运行即可",
    },
  ];

  return (
    <EmptyState
      icon={<Zap />}
      title="让工作流按时自己跑起来"
      description="设置每天几点、每周哪几天或每隔多久触发，再把工作流绑上去；到点后自动启动。"
      action={
        <Button
          variant="primary"
          onClick={onCreate}
          icon={<Plus className="h-4 w-4" />}
        >
          新建触发器
        </Button>
      }
    >
      <div className="mt-6 grid grid-cols-1 gap-2.5 text-left sm:grid-cols-3">
        {steps.map(({ icon: Icon, title, description }) => (
          <div
            key={title}
            className="rounded-lg border border-border/60 bg-surface/60 p-3"
          >
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-soft text-accent">
              <Icon className="h-4 w-4" />
            </span>
            <p className="mt-2 ui-type-label text-text">{title}</p>
            <p className="mt-0.5 ui-type-sub leading-relaxed text-text-muted">
              {description}
            </p>
          </div>
        ))}
      </div>
    </EmptyState>
  );
}

/** 把时间戳格式化为「今天 / 明天 HH:mm」或「MM-DD HH:mm」 */
function formatFireTime(timestamp: number | null): string | null {
  if (timestamp === null) return null;
  const clock = formatHm(timestamp);
  const now = Date.now();

  if (isSameDay(timestamp, now)) return `今天 ${clock}`;

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (isSameDay(timestamp, tomorrow.getTime())) return `明天 ${clock}`;

  const date = new Date(timestamp);
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${clock}`;
}
