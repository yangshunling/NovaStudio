/**
 * 工具授权条 — 展示在输入框上方，不阻塞其它交互。
 *
 * 只显示「当前会话」的待处理请求；其它会话的请求仍由会话列表的
 * 「等待授权」标记提示，切过去后再处理。
 *
 * 请求是带外的（不落库、不进消息流），回答后由主进程写回 CLI stdin。
 */

import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "../ui/Button";
import { useChatStore } from "../../stores/chat";
import { usePermissionPromptStore } from "../../stores/permissionPrompt";

/** 入参预览上限：足够判断命令/路径，又不会把整份文件内容铺满输入区 */
const INPUT_PREVIEW_LIMIT = 3000;

function formatInput(input: unknown): string {
  try {
    const text =
      typeof input === "string" ? input : JSON.stringify(input, null, 2);
    if (!text) return "";
    return text.length > INPUT_PREVIEW_LIMIT
      ? `${text.slice(0, INPUT_PREVIEW_LIMIT)}\n…（已截断）`
      : text;
  } catch {
    return String(input);
  }
}

export function PermissionPromptBanner() {
  const sessionId = useChatStore((s) => s.currentSessionId);

  // 当前会话最早的一条待处理请求
  const requestId = usePermissionPromptStore((s) => {
    if (!sessionId) return null;
    return s.order.find((id) => s.byId[id]?.sessionId === sessionId) ?? null;
  });
  const view = usePermissionPromptStore((s) =>
    requestId ? s.byId[requestId] : null,
  );
  const pendingForSession = usePermissionPromptStore(
    (s) => (sessionId ? (s.countBySession[sessionId] ?? 0) : 0),
  );
  const submitting = usePermissionPromptStore((s) => s.submitting);
  const answer = usePermissionPromptStore((s) => s.answer);

  const [showInput, setShowInput] = useState(false);
  // 切换到下一条请求时收起入参
  useEffect(() => {
    setShowInput(false);
  }, [requestId]);

  if (!view) return null;

  const inputText = formatInput(view.input);

  return (
    <div className="mb-2 rounded-md border border-error/30 bg-error-bg/25 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-error" />
        <span className="shrink-0 ui-type-sub font-semibold text-error">
          需要授权
        </span>
        <span className="shrink-0 ui-type-note font-medium text-text">
          {view.displayName}
        </span>
        {view.description && (
          <code
            title={view.description}
            className="min-w-0 flex-1 truncate ui-type-code-sm text-text-muted"
          >
            {view.description}
          </code>
        )}
        {pendingForSession > 1 && (
          <span className="shrink-0 ui-type-sub text-text-muted">
            还有 {pendingForSession - 1} 个
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {inputText && (
            <button
              type="button"
              onClick={() => setShowInput((value) => !value)}
              aria-expanded={showInput}
              className="rounded px-1.5 py-0.5 ui-type-sub text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
            >
              {showInput ? "收起入参" : "查看入参"}
            </button>
          )}
          <Button
            variant="dangerSoft"
            size="xs"
            onClick={() => void answer(view.requestId, "deny")}
            loading={submitting}
          >
            拒绝
          </Button>
          <Button
            variant="primary"
            size="xs"
            onClick={() => void answer(view.requestId, "allow")}
            disabled={submitting}
          >
            允许
          </Button>
        </div>
      </div>

      {(view.decisionReason || showInput) && (
        <div className="mt-1.5 pl-5">
          {view.decisionReason && (
            <p className="ui-type-sub leading-relaxed text-text-muted">
              {view.decisionReason}
            </p>
          )}
          {showInput && inputText && (
            <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-border/70 bg-input-bg p-2 ui-type-code-sm leading-relaxed text-text-secondary">
              {inputText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
