/**
 * 工具调用卡片
 *
 * 实时对话（AssistantMessageList）与历史回放（MessageList）共用：
 * 同一份工具调用在聊天页、任务详情、工作流运行记录里长得完全一致。
 *
 * 结构：
 * - 头部：工具图标 + 工具名 + 目标 + 状态胶囊 + 折叠箭头
 * - 有文件改动时，头部下方补一行 +N / -N / 文件数摘要
 * - 展开后：diff 优先；没有 diff 时展示输入，以及失败时的错误输出
 *
 * 状态色沿用全站语义：执行中=蓝，完成=绿，失败=红。
 */

import { memo, useMemo, useState } from "react";
import {
  AlertTriangle, Check, ChevronRight, FileText, PenLine, Search, Terminal, Wrench } from "lucide-react";
import type { ToolKind, ToolResultImage } from "@shared/types";
import type { FileChange } from "../../lib/tool-diff";
import { formatJson, truncateText } from "../../lib/utils";
import { imageSrc } from "../../lib/attachment";
import { ToolDiffView } from "./ToolDiffView";
import { Spinner } from "../ui/Spinner";

const TOOL_ICONS: Record<ToolKind, typeof FileText> = {
  read: FileText,
  write: PenLine,
  exec: Terminal,
  search: Search,
  other: Wrench,
};

export interface ToolCallCardProps {
  toolName: string;
  /** 展示对象：文件路径 / 命令 / 检索词 */
  target: string;
  kind: ToolKind;
  args: unknown;
  /** 已格式化好的参数文本；不传时按 args 序列化 */
  argsText?: string;
  /** 工具输出；undefined 表示尚无结果 */
  result?: string;
  /** 工具返回的图片（截图等） */
  resultImages?: ToolResultImage[];
  isError?: boolean;
  /** 是否正在执行（无结果时用于区分「进行中」和「未完成」） */
  running?: boolean;
  changes: FileChange[];
}

/**
 * memo：流式期间父组件每个刷新周期都会重建整条消息的 part，但已完成
 * 工具卡片的 props 引用是稳定的。没有 memo 时，一次回复里几十张卡片
 * （含上千行 diff）会跟着每个 token 一起做 DOM diff。
 */
export const ToolCallCard = memo(function ToolCallCard({
  toolName,
  target,
  kind,
  args,
  argsText,
  result,
  resultImages,
  isError = false,
  running = false,
  changes,
}: ToolCallCardProps) {
  const done = result !== undefined;
  const failed = isError;
  // 改动类工具与带图片的结果默认展开：diff / 截图本身就是最值得看的内容
  const [collapsed, setCollapsed] = useState(
    () => changes.length === 0 && !resultImages?.length,
  );

  const status = failed ? "error" : done ? "done" : running ? "running" : "pending";
  const statusText =
    status === "error"
      ? "失败"
      : status === "done"
        ? "完成"
        : status === "running"
          ? "进行中"
          : "未完成";

  const Icon = TOOL_ICONS[kind];
  // 一次遍历得到增删行数；changes 引用稳定，不必每次渲染重算
  const { adds, dels } = useMemo(() => {
    let added = 0;
    let deleted = 0;
    for (const change of changes) {
      for (const line of change.lines) {
        if (line.type === "add") added += 1;
        else if (line.type === "del") deleted += 1;
      }
    }
    return { adds: added, dels: deleted };
  }, [changes]);

  const tileClass =
    status === "error"
      ? "bg-error-bg text-error"
      : status === "running"
        ? "bg-accent-soft text-accent"
        : "bg-surface-hover text-tool";

  const statusChip =
    status === "error"
      ? "bg-error-bg text-error"
      : status === "done"
        ? "bg-success/10 text-success"
        : status === "running"
          ? "bg-accent-soft text-accent"
          : "bg-surface-hover text-text-muted";

  return (
    <div
      className={`ui-depth w-full overflow-hidden rounded-xl border transition-colors ${
        status === "error"
          ? "border-error/30 bg-error-bg/25"
          : status === "running"
            ? "border-accent/25 bg-accent-soft/15"
            : "border-border/60 bg-surface-2/40"
      }`}
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-surface-hover/40"
      >
        <span
          className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg ${tileClass}`}
        >
          <Icon className="h-3 w-3" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            {/* 工具名是界面标签，跟随全局字体；命令 / 参数仍走等宽 */}
            <span className="shrink-0 ui-type-label text-text">
              {toolName}
            </span>
            {target && (
              <span
                className="min-w-0 truncate ui-type-code-sm text-text-muted"
                title={target}
              >
                {target}
              </span>
            )}
          </span>
          {changes.length > 0 && (
            <span className="mt-0.5 flex items-center gap-2 ui-type-sub tabular-nums">
              {adds > 0 && <span className="text-diff-add">+{adds}</span>}
              {dels > 0 && <span className="text-diff-del">-{dels}</span>}
              <span className="text-text-muted">
                {changes.length} 个文件
              </span>
            </span>
          )}
        </span>

        <span className="flex shrink-0 items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ui-type-sub ${statusChip}`}
          >
            {status === "done" && <Check className="h-3 w-3" />}
            {status === "running" && (
              <Spinner className="h-3 w-3" />
            )}
            {status === "error" && <AlertTriangle className="h-3 w-3" />}
            {statusText}
          </span>
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-text-muted transition-transform ${
              collapsed ? "" : "rotate-90"
            }`}
          />
        </span>
      </button>

      {!collapsed && (
        <div className="ui-well space-y-2 border-t border-border/60 p-3">
          {changes.length > 0 ? (
            <ToolDiffView changes={changes} />
          ) : (
            <div>
              <div className="mb-1 text-micro font-medium text-text-muted">
                输入
              </div>
              <pre className="max-h-40 overflow-auto rounded-lg border border-border/60 bg-surface-2/50 px-2.5 py-2 ui-type-code-sm leading-relaxed text-text-secondary">
                {truncateText(argsText ?? formatJson(args), 500)}
              </pre>
            </div>
          )}

          {/* 有 diff 且成功时回执没有信息量；失败时错误信息必须保留 */}
          {done && result && (changes.length === 0 || failed) && (
            <div>
              <div className="mb-1 text-micro font-medium text-text-muted">
                {failed ? "错误" : "输出"}
              </div>
              <pre
                className={`max-h-48 overflow-auto rounded-lg border px-2.5 py-2 ui-type-code-sm leading-relaxed ${
                  failed
                    ? "border-error/30 bg-error-bg text-error"
                    : "border-border/60 bg-surface-2/50 text-text-muted"
                }`}
              >
                {truncateText(result, 500)}
              </pre>
            </div>
          )}

          {/* 截图 / 图片类工具输出：base64 直接内联展示，避免再落文件 */}
          {resultImages && resultImages.length > 0 && (
            <div>
              <div className="mb-1 text-micro font-medium text-text-muted">
                图片
              </div>
              <div className="flex flex-wrap gap-2">
                {resultImages.map((image, index) => {
                  const src = imageSrc(image);
                  if (!src) return null;
                  return (
                    <img
                      key={index}
                      src={src}
                      alt={`工具输出图片 ${index + 1}`}
                      className="max-h-80 max-w-full rounded-lg border border-border/60 object-contain"
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
