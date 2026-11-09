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

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  PenLine,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ToolKind, ToolResultImage } from "@shared/types";
import type { FileChange } from "../../lib/tool-diff";
import { truncateText } from "../../lib/utils";
import { ToolDiffView } from "./ToolDiffView";

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

export function ToolCallCard({
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
  const adds = changes.reduce(
    (sum, change) =>
      sum + change.lines.filter((line) => line.type === "add").length,
    0,
  );
  const dels = changes.reduce(
    (sum, change) =>
      sum + change.lines.filter((line) => line.type === "del").length,
    0,
  );

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
      className={`ui-cv-block w-full overflow-hidden rounded-xl border transition-colors ${
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
            <span className="shrink-0 font-mono text-meta font-medium text-text">
              {toolName}
            </span>
            {target && (
              <span
                className="min-w-0 truncate font-mono text-caption text-text-muted"
                title={target}
              >
                {target}
              </span>
            )}
          </span>
          {changes.length > 0 && (
            <span className="mt-0.5 flex items-center gap-2 text-caption tabular-nums">
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
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-caption ${statusChip}`}
          >
            {status === "done" && <Check className="h-3 w-3" />}
            {status === "running" && (
              <Loader2 className="h-3 w-3 animate-spin" />
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
        <div className="space-y-2 border-t border-border/60 bg-surface/50 p-3">
          {changes.length > 0 ? (
            <ToolDiffView changes={changes} />
          ) : (
            <div>
              <div className="mb-1 text-micro font-medium text-text-muted">
                输入
              </div>
              <pre className="max-h-40 overflow-auto rounded-lg border border-border/60 bg-surface-2/50 px-2.5 py-2 font-mono text-caption leading-relaxed text-text-secondary">
                {truncateText(
                  argsText ?? JSON.stringify(args ?? {}, null, 2),
                  500,
                )}
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
                className={`max-h-48 overflow-auto rounded-lg border px-2.5 py-2 font-mono text-caption leading-relaxed ${
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
                {resultImages.map((image, index) => (
                  <img
                    key={index}
                    src={`data:${image.mediaType};base64,${image.data}`}
                    alt={`工具输出图片 ${index + 1}`}
                    className="max-h-80 max-w-full rounded-lg border border-border/60 object-contain"
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
