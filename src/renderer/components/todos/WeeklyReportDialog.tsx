/**
 * 生成周报弹窗
 *
 * 左侧配置周期与口径，右侧流式预览。生成走主进程的一次性文本生成，
 * 不创建会话、不写历史；关闭弹窗会取消正在进行的生成。
 *
 * 配置默认值只在这个弹窗里维护，不落库：周报是偶发动作，
 * 记住上次的选择反而会让「本周」这个默认语义变得不可预期。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, FileText, Sparkles, Square } from "lucide-react";
import type { TodoItem } from "@shared/types";
import {
  DEFAULT_REPORT_OPTIONS,
  collectReportBundle,
  formatMonthDay,
  formatYmd,
  resolveReportRange,
  type ReportPeriod,
  type ReportStyle,
  type WeeklyReportOptions,
} from "@shared/report";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { toast } from "../../stores/toast";
import { Button } from "../ui/Button";
import { Dialog, DialogActions } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { Field, FORM_INPUT_CLASS } from "../ui/Field";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { OptionChips } from "../ui/OptionChips";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { fromDateInputValue, toDateInputValue } from "./todoUtils";

const PERIOD_OPTIONS: { value: ReportPeriod; label: string }[] = [
  { value: "this-week", label: "本周" },
  { value: "last-week", label: "上周" },
  { value: "last-7", label: "最近 7 天" },
  { value: "custom", label: "自定义区间" },
];

const STYLE_OPTIONS: { id: ReportStyle; label: string }[] = [
  { id: "concise", label: "简洁条列" },
  { id: "formal", label: "正式周报" },
  { id: "executive", label: "汇报口径" },
];

type Status = "idle" | "running" | "done" | "error";

/** 单次生成的请求标识：只用于把流式片段路由回本弹窗 */
function newRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface WeeklyReportDialogProps {
  open: boolean;
  onClose: () => void;
  todos: TodoItem[];
}

export function WeeklyReportDialog({
  open,
  onClose,
  todos,
}: WeeklyReportDialogProps) {
  const [period, setPeriod] = useState<ReportPeriod>("this-week");
  const [customStart, setCustomStart] = useState<number | null>(null);
  const [customEnd, setCustomEnd] = useState<number | null>(null);
  const [options, setOptions] = useState<WeeklyReportOptions>(
    DEFAULT_REPORT_OPTIONS,
  );

  const [status, setStatus] = useState<Status>("idle");
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const startedAtRef = useRef<number | null>(null);
  const activeRequestRef = useRef<string | null>(null);
  const abortedRef = useRef(false);

  /*
   * 「本周」依赖当天日期。弹窗可能挂载很久，每次打开时刷新一次基准时间，
   * 避免跨天后仍按旧的周一算周期。
   */
  const [openAt, setOpenAt] = useState(() => Date.now());

  const running = status === "running";

  const range = useMemo(
    () => resolveReportRange(period, customStart, customEnd, openAt),
    [period, customStart, customEnd, openAt],
  );

  /** 当前配置下实际会进入周报的素材 */
  const bundle = useMemo(
    () => collectReportBundle(todos, range, options),
    [todos, range, options],
  );

  /** 候选板块不能受 excludeSections 影响，否则排除后就再也加不回来 */
  const allSections = useMemo(
    () =>
      collectReportBundle(todos, range, { ...options, excludeSections: [] })
        .sections,
    [todos, range, options],
  );

  /* 每次打开都从干净状态开始，但保留上一次的配置习惯 */
  useEffect(() => {
    if (!open) return;
    setStatus("idle");
    setMarkdown("");
    setError("");
    setElapsed(0);
    setOpenAt(Date.now());
    startedAtRef.current = null;
  }, [open]);

  /* 流式片段：只接收本弹窗发起的那一次生成 */
  useEffect(() => {
    const off = ipc.on.reportChunk(({ requestId, chunk }) => {
      if (requestId !== activeRequestRef.current) return;
      setMarkdown((prev) => prev + chunk);
    });
    return off;
  }, []);

  /* 生成中的计时，给「还要等多久」一个可感知的参照 */
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const started = startedAtRef.current;
      if (started) setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [running]);

  const patchOptions = (next: Partial<WeeklyReportOptions>) => {
    setOptions((prev) => ({ ...prev, ...next }));
  };

  const stop = async () => {
    const requestId = activeRequestRef.current;
    if (!requestId) return;
    /*
     * 先摘掉句柄再发取消：主进程杀掉子进程前可能还有片段在路上，
     * 句柄为空后这些片段会被忽略，不会把已清空的预览重新填满。
     */
    activeRequestRef.current = null;
    abortedRef.current = true;
    // 半份周报没有导出价值，停止时直接清空，避免误复制
    setMarkdown("");
    setStatus("idle");
    try {
      await ipc.abortWeeklyReport(requestId);
    } catch {
      // 取消失败不阻塞关闭：主进程会按超时自行收尾
    }
  };

  const requestClose = () => {
    if (running) void stop();
    onClose();
  };

  const generate = async () => {
    if (running) return;
    setError("");

    if (bundle.entries.length === 0) {
      setError(
        "所选周期没有符合条件的记录。换个周期，或在「包含」里勾选未完成 / 无日期项。",
      );
      setStatus("error");
      return;
    }

    const requestId = newRequestId();
    activeRequestRef.current = requestId;
    abortedRef.current = false;
    startedAtRef.current = Date.now();
    setMarkdown("");
    setStatus("running");
    setElapsed(0);

    try {
      const result = await ipc.generateWeeklyReport(
        requestId,
        range.start,
        range.end,
        options,
      );
      // 已经停止，或用户重开后发起了新的一次生成：旧结果直接丢弃
      if (abortedRef.current || activeRequestRef.current !== requestId) return;
      if (result.ok) {
        setMarkdown(result.markdown);
        setStatus("done");
      } else {
        setError(result.error);
        setStatus("error");
      }
    } catch (err) {
      if (!abortedRef.current) {
        setError(toMessage(err));
        setStatus("error");
      }
    } finally {
      // 只清理本次请求；用户已发起新一轮时不能把新请求的句柄清掉
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = null;
        if (abortedRef.current) {
          abortedRef.current = false;
          setStatus("idle");
        }
      }
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success("周报已复制");
    } catch (err) {
      toast.error(toMessage(err));
    }
  };

  const exportMarkdown = async () => {
    try {
      const path = await ipc.exportReport(
        markdown,
        `周报-${formatYmd(range.start)}-${formatYmd(range.end - 1)}.md`,
      );
      if (path) toast.success("周报已导出");
    } catch (err) {
      toast.error(toMessage(err));
    }
  };

  const contentSelection = [
    ...(options.includeDone ? ["done"] : []),
    ...(options.includePending ? ["pending"] : []),
    ...(options.includeUndated ? ["undated"] : []),
  ];

  const toggleContent = (id: string | number) => {
    if (id === "done") patchOptions({ includeDone: !options.includeDone });
    if (id === "pending") {
      patchOptions({
        includePending: !options.includePending,
        // 没有未完成项时，「无日期」没有意义，一并收起
        includeUndated: options.includePending
          ? false
          : options.includeUndated,
      });
    }
    if (id === "undated") {
      patchOptions({ includeUndated: !options.includeUndated });
    }
  };

  const toggleSection = (id: string | number) => {
    const name = String(id);
    patchOptions({
      excludeSections: options.excludeSections.includes(name)
        ? options.excludeSections.filter((item) => item !== name)
        : [...options.excludeSections, name],
    });
  };

  const rangeLabel = `${formatMonthDay(range.start)} - ${formatMonthDay(
    range.end - 1,
  )}`;

  const preview = (() => {
    if (markdown) {
      return (
        <MarkdownRenderer content={markdown} streaming={running} />
      );
    }
    if (running) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
          <div className="flex items-center gap-2 ui-type-body">
            <Spinner className="h-4 w-4" />
            正在生成周报… {elapsed}s
          </div>
          <p className="ui-type-sub">
            已整理 {bundle.entries.length} 条记录
          </p>
        </div>
      );
    }
    if (error) {
      return (
        <EmptyState
          size="compact"
          icon={<FileText />}
          title="没有生成内容"
          description={error}
        />
      );
    }
    return (
      <EmptyState
        size="compact"
        icon={<Sparkles />}
        title="还没有生成"
        description={`将整理 ${rangeLabel} 内的 ${bundle.entries.length} 条记录，点击「生成」开始。`}
      />
    );
  })();

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      requestClose={requestClose}
      title="生成周报"
      width="xl"
      description="从当前周期的待办自动整理成周报草稿，生成后可复制或导出。"
    >
      <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* 左侧：配置 */}
        <div
          className={`space-y-4 ${running ? "pointer-events-none opacity-60" : ""}`}
          aria-busy={running}
        >
          <Field label="周期">
            <Select
              value={period}
              onChange={(value) => setPeriod(value as ReportPeriod)}
              options={PERIOD_OPTIONS}
              disabled={running}
              aria-label="周报周期"
            />
            {period === "custom" && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="date"
                  aria-label="起始日期"
                  className={`${FORM_INPUT_CLASS} min-w-0`}
                  value={toDateInputValue(customStart ?? range.start)}
                  onChange={(event) =>
                    setCustomStart(fromDateInputValue(event.target.value))
                  }
                />
                <span className="text-text-muted">至</span>
                <input
                  type="date"
                  aria-label="结束日期"
                  className={`${FORM_INPUT_CLASS} min-w-0`}
                  value={toDateInputValue(customEnd ?? range.end - 1)}
                  onChange={(event) =>
                    setCustomEnd(fromDateInputValue(event.target.value))
                  }
                />
              </div>
            )}
            <p className="mt-1.5 ui-type-note text-text-muted">
              {rangeLabel} · 已完成 {bundle.done.length}，未完成{" "}
              {bundle.pending.length}
            </p>
          </Field>

          <Field label="口径">
            <OptionChips
              mode="single"
              items={STYLE_OPTIONS}
              selected={options.style}
              onSelect={(id) => patchOptions({ style: id as ReportStyle })}
            />
          </Field>

          <Field label="包含">
            <OptionChips
              mode="multi"
              size="md"
              items={[
                { id: "done", label: "已完成" },
                { id: "pending", label: "未完成" },
                {
                  id: "undated",
                  label: "无日期",
                  disabled: !options.includePending,
                },
              ]}
              selected={contentSelection}
              onToggle={toggleContent}
            />
          </Field>

          <Field
            label="排除板块"
            hint="点击板块名可将其排除在本期之外"
          >
            {allSections.length === 0 ? (
              <p className="ui-type-note text-text-muted">该周期没有板块</p>
            ) : (
              <OptionChips
                mode="multi"
                className="max-h-28 overflow-y-auto"
                items={allSections.map((section) => ({
                  id: section,
                  label: section,
                }))}
                selected={options.excludeSections}
                onToggle={toggleSection}
              />
            )}
          </Field>
        </div>

        {/* 右侧：预览 */}
        <div className="flex min-h-[360px] flex-col overflow-hidden rounded-xl border border-border/70 bg-surface-2/30">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-3">
            <span className="ui-type-note font-medium text-text-secondary">
              预览
              {running && (
                <span className="ml-2 tabular-nums text-text-muted">
                  {elapsed}s
                </span>
              )}
            </span>
            {running && (
              <button
                type="button"
                onClick={() => void stop()}
                className="inline-flex items-center gap-1 ui-type-note text-text-muted transition-colors hover:text-error"
              >
                <Square className="h-3 w-3" />
                停止
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {error && markdown && (
              <p className="mb-3 rounded-lg border border-error/30 bg-error-bg/70 px-3 py-2 ui-type-note text-error">
                {error}
              </p>
            )}
            {preview}
          </div>
        </div>
      </div>

      <DialogActions className="justify-between">
        <span className="ui-type-note text-text-muted">
          {running
            ? "关闭弹窗会取消本次生成"
            : markdown
              ? "生成内容仅供草稿，发布前请自行核对"
              : ""}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            icon={<Copy className="h-4 w-4" />}
            disabled={!markdown || running}
            onClick={() => void copy()}
          >
            复制
          </Button>
          <Button
            variant="ghost"
            icon={<Download className="h-4 w-4" />}
            disabled={!markdown || running}
            onClick={() => void exportMarkdown()}
          >
            导出
          </Button>
          <Button
            variant="primary"
            size="md"
            loading={running}
            icon={<Sparkles className="h-4 w-4" />}
            onClick={() => void generate()}
          >
            {markdown ? "重新生成" : error ? "重试" : "生成"}
          </Button>
        </div>
      </DialogActions>
    </Dialog>
  );
}
