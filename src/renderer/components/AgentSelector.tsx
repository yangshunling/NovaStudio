/**
 * 智能体选择器 — 输入框旁的紧凑下拉
 *
 * 为什么放在输入框旁：Agent 的选择属于「这次提问用谁来答」，
 * 放在提问处才符合直觉（参考 Claude Code / Codex 的输入框内模型选择）。
 *
 * 关键约束：**只在会话开始前可选**。
 * 会话一旦开始（currentSessionId 已确定），本次会话由哪个 Agent 执行就定死了，
 * 触发器进入锁定态且不可点击 —— 换 Agent 只能新开一个会话。
 *
 * 交互：
 *   点击触发器 → 向上展开面板（输入框在底部，向下没有空间）
 *   键盘：↑↓ 选择、Enter 确认、Esc / 外部点击 关闭
 *   未安装项置灰且禁用，但可 hover 查看版本信息
 *
 * 展示数据全部来自 AgentInfo（manifest + 检测状态），不硬编码任何具体 Agent。
 */

import { useState, useRef, useEffect } from "react";
import { Bot, ChevronDown, Check, Lock, AlertCircle } from "lucide-react";
import { agentTone } from "../lib/utils";
import type { AgentInfo } from "@shared/contracts/agent";

export function AgentSelector({
  agents,
  agentId,
  locked,
  onSelect,
}: {
  agents: AgentInfo[];
  /** 当前生效的 Agent id（会话进行中时为该会话实际的 Agent） */
  agentId: string;
  /** 会话已开始：锁定不可修改 */
  locked: boolean;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const selected = agents.find((a) => a.id === agentId);
  /** 标识色由 manifest 的 tone 决定，选择器只负责套用 */
  const selectedTone = agentTone(agents, agentId);

  // 展开时：监听外部点击 / Esc 关闭，并把 hover 定位到当前选中项
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

  // 打开时把选中项滚进视口
  useEffect(() => {
    if (!open) return;
    const idx = agents.findIndex((a) => a.id === agentId);
    setHoverIdx(idx < 0 ? 0 : idx);
    requestAnimationFrame(() => {
      itemRefs.current[idx]?.scrollIntoView({ block: "nearest" });
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setHoverIdx((i) => Math.min(i + 1, agents.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHoverIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const agent = agents[hoverIdx];
      if (agent?.status.installed && agent.id !== agentId) onSelect(agent.id);
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  /** 副标题：版本 / 就绪 / 未检测 */
  const subtitle = (agent: AgentInfo): string =>
    agent.status.version
      ? `v${agent.status.version}`
      : agent.status.installed
        ? "就绪"
        : "未检测";

  const label = agents.length === 0 ? "检测中…" : (selected?.displayName ?? "选择 Agent");

  return (
    <div ref={rootRef} className="relative shrink-0">
      {/* 触发器：紧凑药丸。锁定态不可点击，只展示"本次会话用谁" */}
      <button
        type="button"
        disabled={locked}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        title={locked ? "会话已开始，Agent 不可更换" : "选择本次会话使用的 Agent"}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`ui-ring flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-input-bg px-3 text-meta text-text-secondary outline-none transition-all ${
          locked
            ? "cursor-default opacity-70"
            : "hover:border-input-border-focus hover:text-text"
        } ${open ? "border-input-border-focus text-text" : ""}`}
      >
        <Bot className={`h-3.5 w-3.5 shrink-0 ${selectedTone.fg}`} />
        <span className="max-w-[120px] truncate font-medium">{label}</span>
        {locked ? (
          <Lock className="h-3 w-3 shrink-0 text-text-muted" />
        ) : (
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        )}
      </button>

      {/* 下拉面板：向上展开，玻璃拟态 + 描边 */}
      {open && (
        <ul
          role="listbox"
          className="ui-dropdown-in ui-glass-strong ui-ring absolute bottom-full right-0 z-50 mb-2 w-64 rounded-xl p-1.5"
          style={{ boxShadow: "var(--c-shadow)" }}
        >
          <li className="px-2.5 pb-1.5 pt-1 text-caption text-text-muted">
            为本次新会话选择 Agent
          </li>
          {agents.length === 0 && (
            <li className="px-3 py-3 text-meta text-text-muted">未检测到可用的 Agent</li>
          )}
          {agents.map((agent, i) => {
            const active = agent.id === agentId;
            const hovered = i === hoverIdx;
            const tone = agentTone(agents, agent.id);
            return (
              <li key={agent.id} role="option" aria-selected={active}>
                <button
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  disabled={!agent.status.installed}
                  onClick={() => {
                    if (agent.status.installed) onSelect(agent.id);
                    setOpen(false);
                  }}
                  onMouseEnter={() => setHoverIdx(i)}
                  className={`relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    hovered ? "bg-surface-hover" : ""
                  } ${active ? "ui-active bg-surface-active" : ""} ${
                    !agent.status.installed ? "opacity-55" : ""
                  }`}
                >
                  <span
                    className={`flex size-avatar shrink-0 items-center justify-center rounded-md ${tone.soft} ${tone.fg}`}
                  >
                    <Bot className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-text">
                      {agent.displayName}
                    </span>
                    <span className="flex items-center gap-1.5 text-caption text-text-muted">
                      {agent.status.installed ? (
                        subtitle(agent)
                      ) : (
                        <span className="inline-flex items-center gap-1 text-error">
                          <AlertCircle className="h-3 w-3" />
                          未安装
                        </span>
                      )}
                    </span>
                  </span>
                  {active && <Check className="h-4 w-4 shrink-0 text-accent" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
