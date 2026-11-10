/**
 * 思考过程卡片
 *
 * 与工具调用卡（ToolCallCard）共用同一套外形：
 * 图标块 + 标题 + 状态胶囊 + 折叠箭头，展开后是同款描边内容区。
 * 这样「思考」和「工具」在消息流里属于同一类可折叠过程节点，视觉不跳。
 *
 * 实时对话与历史回放共用本组件；实时流式输出时内容区会自动跟随底部。
 */

import { useEffect, useRef, useState } from "react";
import { Brain, Check, ChevronRight } from "lucide-react";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { Spinner } from "../ui/Spinner";

export function ThinkingCard({
  text,
  running,
}: {
  text: string;
  /** 思考仍在流式输出：显示「进行中」并自动跟随底部 */
  running: boolean;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 贴近底部才跟随：用户主动往上翻阅时不被拉回 */
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (!running) return;
    const element = bodyRef.current;
    if (!element || !stickToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [text, running, collapsed]);

  const handleBodyScroll = () => {
    const element = bodyRef.current;
    if (!element) return;
    stickToBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };

  return (
    <div
      className={`w-full overflow-hidden rounded-xl border transition-colors ${
        running
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
          className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg ${
            running ? "bg-accent-soft text-accent" : "bg-surface-hover text-thinking"
          }`}
        >
          <Brain className="h-3 w-3" />
        </span>

        <span className="min-w-0 flex-1 ui-type-label text-text">
          思考过程
        </span>

        <span className="flex shrink-0 items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ui-type-sub ${
              running
                ? "bg-accent-soft text-accent"
                : "bg-success/10 text-success"
            }`}
          >
            {running ? (
              <Spinner className="h-3 w-3" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {running ? "思考中" : "完成"}
          </span>
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-text-muted transition-transform ${
              collapsed ? "" : "rotate-90"
            }`}
          />
        </span>
      </button>

      {!collapsed && (
        <div
          ref={bodyRef}
          onScroll={handleBodyScroll}
          className="max-h-60 overflow-auto border-t border-border/60 bg-surface/50 p-3 ui-type-note leading-relaxed text-text-secondary"
        >
          <MarkdownRenderer content={text} streaming={running} />
        </div>
      )}
    </div>
  );
}
