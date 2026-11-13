/**
 * 权限模式选择器 — 输入框旁的紧凑下拉
 *
 * 权限是「本次任务怎么跑」的运行参数，而不是 Agent 的全局身份：
 * 读代码、改文件、跑命令对权限的要求每次都不同，放在提问处随手切换最顺手。
 *
 * 语义：
 *   - 已开会话：写会话记录，下一轮运行生效（不影响正在跑的进程）；
 *   - 新会话：只记在草稿里，首条消息创建会话时一并落库；
 *   - Agent 配置里的默认值只决定新会话的初始档位。
 *
 * 档位列表与说明来自 @shared/permission，与 Agent 配置页共用一份定义。
 */

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ShieldAlert,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_OPTIONS,
} from "@shared/permission";
import { useChatStore } from "../../stores/chat";
import { toast } from "../../stores/toast";
import { errorMessage } from "@shared/error";

/** 高风险的档位用警示色，其余保持中性，避免工具栏过于花哨 */
function modeIcon(value: string): LucideIcon {
  return value === "bypassPermissions" ? ShieldAlert : ShieldCheck;
}

function modeTone(value: string): string {
  return value === "bypassPermissions" ? "text-error" : "text-text-muted";
}

export function PermissionSelector() {
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const draftMode = useChatStore((s) => s.selectedPermissionMode);
  const setPermissionMode = useChatStore((s) => s.setPermissionMode);
  const streaming = useChatStore((s) =>
    s.currentSessionId ? !!s.streamingBySession[s.currentSessionId] : false,
  );

  const session = currentSessionId
    ? sessions.find((item) => item.id === currentSessionId)
    : undefined;
  const value = currentSessionId
    ? (session?.permissionMode ?? DEFAULT_PERMISSION_MODE)
    : draftMode;

  /** 配置文件里可能是未来档位 / 自定义值：补进候选项，避免下拉显示为空 */
  const options = PERMISSION_MODE_OPTIONS.some((item) => item.value === value)
    ? PERMISSION_MODE_OPTIONS
    : [
        { value, label: `${value} (current)`, description: "自定义模式" },
        ...PERMISSION_MODE_OPTIONS,
      ];
  const selected = options.find((item) => item.value === value);
  const Icon = modeIcon(value);

  const [open, setOpen] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 切换会话时收起面板，避免停留在上一个会话的选择态
  useEffect(() => {
    setOpen(false);
  }, [currentSessionId]);

  // 展开时：外部点击 / Esc 关闭，并把高亮定位到当前项
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((item) => item.value === value);
    setHoverIdx(idx < 0 ? 0 : idx);
    requestAnimationFrame(() => {
      itemRefs.current[idx]?.scrollIntoView({ block: "nearest" });
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const activate = async (index: number) => {
    const option = options[index];
    setOpen(false);
    if (!option || option.value === value) return;
    try {
      await setPermissionMode(option.value);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHoverIdx((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHoverIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void activate(hoverIdx);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((next) => !next)}
        onKeyDown={onKeyDown}
        title={
          streaming
            ? "本轮运行中，权限切换从下一轮生效"
            : `当前权限：${selected?.label ?? value} · ${selected?.description ?? ""}`
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`ui-toolbar-chip shrink-0 text-text-muted hover:bg-surface-hover hover:text-text ${
          open ? "bg-surface-hover text-text" : ""
        }`}
      >
        <Icon
          className={`h-icon-sm w-icon-sm shrink-0 ${
            value === "bypassPermissions" ? "text-error" : "text-text-muted"
          }`}
        />
        <span className="min-w-0 truncate text-left font-medium text-text">
          {selected?.label ?? value}
        </span>
        <ChevronDown
          className={`h-icon-sm w-icon-sm shrink-0 text-text-muted transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="ui-dropdown-in ui-glass-strong ui-ring absolute bottom-full left-0 z-50 mb-2 w-dropdown max-w-[calc(100vw-2rem)] rounded-xl p-1.5"
          style={{ boxShadow: "var(--c-shadow)" }}
        >
          <div className="flex items-center gap-1 px-2 pb-1 pt-0.5">
            <span className="min-w-0 flex-1 truncate ui-type-sub text-text-muted">
              {streaming
                ? "本轮运行中，切换从下一轮生效"
                : currentSessionId
                  ? "本次会话的权限模式"
                  : "新会话的权限模式（也决定后续新会话）"}
            </span>
            <span className="shrink-0 ui-type-sub text-text-muted/70">
              ↑↓ 选择
            </span>
          </div>

          {options.map((option, index) => {
            const active = option.value === value;
            const hovered = index === hoverIdx;
            const OptionIcon = modeIcon(option.value);
            return (
              <button
                key={option.value}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="option"
                aria-selected={active}
                onMouseEnter={() => setHoverIdx(index)}
                onClick={() => void activate(index)}
                title={option.description}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                  hovered
                    ? "bg-surface-hover text-text"
                    : active
                      ? "bg-surface-active text-text"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text"
                }`}
              >
                <OptionIcon
                  className={`h-3.5 w-3.5 shrink-0 ${modeTone(option.value)}`}
                />
                <span
                  className={`w-[7.6rem] shrink-0 truncate ui-type-note font-medium ${
                    active ? "text-accent" : ""
                  }`}
                >
                  {option.label}
                </span>
                <span className="min-w-0 flex-1 truncate ui-type-sub text-text-muted">
                  {option.description}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
