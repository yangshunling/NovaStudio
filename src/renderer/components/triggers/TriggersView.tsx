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
  Search,
  Trash2,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { useLoad } from "../../hooks/useLoad";
import {
  EmptyBlock,
  EmptyState,
  ErrorState,
  FilterEmpty,
  LoadingState,
} from "../ui/EmptyState";
import { Page, PageBody, PageHeader } from "../ui/Page";
import { OptionChips } from "../ui/OptionChips";
import {
  CARD_DESCRIPTION,
  CARD_FOOTER,
  CARD_ICON_TILE,
  CARD_SHELL,
  CARD_TITLE,
} from "../ui/cardStyles";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import { Dialog, DialogActions } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { SearchInput } from "../ui/SearchInput";
import { Field, TextArea, TextInput } from "../ui/Field";
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

  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return triggers;
    return triggers.filter((trigger) =>
      [trigger.title, trigger.description].some((value) =>
        value.toLowerCase().includes(keyword),
      ),
    );
  }, [triggers, query]);

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
          <>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="搜索标题 / 描述"
            />
            <Button
              variant="primary"
              onClick={() => setEditing("new")}
              icon={<Plus className="h-4 w-4" />}
            >
              新建触发器
            </Button>
          </>
        }
      />

      <PageBody>
          {loading ? (
            <LoadingState text="正在加载触发器" />
          ) : error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : triggers.length === 0 ? (
            <EmptyTriggers onCreate={() => setEditing("new")} />
          ) : filtered.length === 0 ? (
            <FilterEmpty
              title={`没有匹配「${query}」的触发器`}
              onClear={() => setQuery("")}
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((trigger) => (
                <TriggerCard
                  key={trigger.id}
                  trigger={trigger}
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
                      ? "border-accent/50 bg-accent-soft/40"
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
                    <span className="block truncate text-body font-medium text-text">
                      {workflow.name}
                    </span>
                    {workflow.description && (
                      <span className="mt-0.5 block truncate text-meta text-text-muted">
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
  onToggle,
  onBind,
  onEdit,
  onDelete,
}: {
  trigger: WorkflowTrigger;
  onToggle: (enabled: boolean) => void;
  onBind: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={CARD_SHELL}>
      <div className="flex items-start gap-3">
        <span className={CARD_ICON_TILE}>
          <Zap className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className={CARD_TITLE}>{trigger.title}</h3>
          <p className={`mt-2 ${CARD_DESCRIPTION}`}>
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
        <span className="flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 text-text-secondary">
          <AlarmClock className="h-3 w-3 text-accent" />
          {describeTriggerSchedule(trigger.schedule)}
        </span>
      </div>

      {trigger.lastError && (
        <p
          className="mt-2 line-clamp-2 break-words rounded-lg bg-error-bg px-2.5 py-1.5 text-meta leading-relaxed text-error"
          title={trigger.lastError}
        >
          最近一次触发失败：{trigger.lastError}
        </p>
      )}

      <div className={CARD_FOOTER}>
        <p
          className={`min-w-0 truncate text-meta text-text-muted ${
            trigger.enabled ? "" : "opacity-70"
          }`}
        >
          {trigger.enabled
            ? `下次执行 ${formatFireTime(trigger.nextFireAt) ?? "待计算"}`
            : "已停用"}
        </p>
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
            <div className="mb-1.5 text-meta font-medium text-text-secondary">
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
            <p className="mt-1 text-meta text-text-muted">{kindHint}</p>
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
                <span className="text-body text-text-muted">分钟</span>
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
                  <div className="mb-1.5 text-meta font-medium text-text-secondary">
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
                    <p className="mt-1 text-meta text-error">
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
  return (
    <EmptyState
      icon={<Zap />}
      title="让工作流按时自己跑起来"
      description="先创建一个触发器，设置每天几点、每周哪几天或每隔多久触发；再在工作流卡片的右键菜单里把触发器绑上去。"
      action={
        <Button
          variant="primary"
          onClick={onCreate}
          icon={<Plus className="h-4 w-4" />}
        >
          新建触发器
        </Button>
      }
    />
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
