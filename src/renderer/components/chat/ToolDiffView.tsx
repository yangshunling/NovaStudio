/**
 * 工具调用的文件变更 diff 视图
 *
 * 只在展开工具节点时渲染。历史消息与实时消息共用（AssistantMessageList /
 * MessageList 两条渲染路径都走这里），保证同一份改动在哪儿看都一样。
 *
 * 行号取文件里的真实行号（provider 定位得到时）；定位不到就整体不画行号，
 * 不要从 1 开始编造。左侧只有一列行号：删除行显示旧行号，其余显示新行号。
 */

import type { DiffLine, FileChange } from "../../lib/tool-diff";

const ROW_CLASS: Record<DiffLine["type"], string> = {
  add: "bg-diff-add-bg",
  del: "bg-diff-del-bg",
  ctx: "",
};

const SIGN: Record<DiffLine["type"], string> = {
  add: "+",
  del: "-",
  ctx: " ",
};

const SIGN_CLASS: Record<DiffLine["type"], string> = {
  add: "text-diff-add",
  del: "text-diff-del",
  ctx: "text-text-muted",
};

const TEXT_CLASS: Record<DiffLine["type"], string> = {
  add: "text-diff-add",
  del: "text-diff-del",
  ctx: "text-text-secondary",
};

export function ToolDiffView({ changes }: { changes: FileChange[] }) {
  if (changes.length === 0) return null;
  // 工具行已经展示了文件路径：只有多段变更落在不同文件时才需要再标一次
  const showPath = new Set(changes.map((change) => change.path)).size > 1;

  return (
    <div className="w-full space-y-1">
      {changes.map((change, index) => (
        <div
          key={`${change.path}-${index}`}
          className="overflow-hidden rounded-md border border-border bg-surface"
        >
          {showPath && (
            <div className="min-w-0 truncate border-b border-border px-2 py-1 font-mono text-micro text-text-muted">
              {change.path || "变更"}
            </div>
          )}
          <div className="max-h-80 overflow-auto">
            {/* 不要纵向内边距：底色块贴着卡片上下沿，暗色下才不会出现黑边 */}
            <div className="w-max min-w-full font-mono text-meta leading-6">
              {change.lines.map((line, lineIndex) => (
                <DiffRow
                  key={lineIndex}
                  line={line}
                  numbered={change.numbered}
                  gutterWidth={gutterWidth(change)}
                />
              ))}
              {change.hiddenLines > 0 && (
                <div className="px-3 py-1 text-text-muted">
                  … 已折叠 {change.hiddenLines} 行
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 行号列宽按该变更里最长的行号计算，并让所有行共用 —— 每行各自撑宽会
 * 让 1 位数与 3 位数错开，这正是需要避免的“数字对不齐”。
 */
function gutterWidth(change: FileChange): string {
  let digits = 2;
  for (const line of change.lines) {
    const value = line.type === "del" ? line.oldLine : line.newLine;
    if (value !== null) digits = Math.max(digits, String(value).length);
  }
  // +1 给右侧留白
  return `${digits + 1}ch`;
}

function DiffRow({
  line,
  numbered,
  gutterWidth,
}: {
  line: DiffLine;
  numbered: boolean;
  gutterWidth: string;
}) {
  // 单列行号：删除行指向旧文件，其余指向新文件
  const lineNo = line.type === "del" ? line.oldLine : line.newLine;

  return (
    <div className={`flex ${ROW_CLASS[line.type]}`}>
      {numbered && (
        <span
          className="shrink-0 select-none pr-2 text-right tabular-nums text-text-muted/70"
          style={{ width: gutterWidth }}
        >
          {lineNo ?? ""}
        </span>
      )}
      <span
        className={`w-4 shrink-0 select-none text-center font-medium ${SIGN_CLASS[line.type]}`}
      >
        {SIGN[line.type]}
      </span>
      <span className={`whitespace-pre pr-3 ${TEXT_CLASS[line.type]}`}>
        {line.text || " "}
      </span>
    </div>
  );
}
