/**
 * 数字员工选择器 — 输入框旁、工作区右侧的紧凑下拉
 *
 * 语义：选择「这次任务由哪位数字员工来答」。
 *   - 未选员工 → 不使用员工，走 Agent 全局配置
 *   - 选中员工 → 本次会话使用该员工的提示词 / MCP / 技能 / 知识库
 *
 * 列表只展示已启用的员工：停用员工在运行时不可用，放进来只会让人选了才发现。
 * 选中后立即回显到触发器；已开会话的绑定写进该会话的快照，切换会话仍能还原。
 *
 * 行样式与「指定工作区」保持一致：单行、紧凑高度，名称与副标题同一行。
 * 运行中与工作区一样禁止切换。
 */

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Lock,
  Settings2,
  UserMinus,
  UserRound,
} from "lucide-react";
import { useChatStore } from "../../stores/chat";
import { useEmployeesStore } from "../../stores/employees";
import { chooseEmployee } from "../../lib/employee-switch";
import { EmployeeAvatar } from "../employees/EmployeeAvatar";

/** 弹窗里的一行，字段对齐工作区菜单的「图标 + 名称 + 副标题 + 当前标记」 */
type EmployeeRow =
  | { kind: "none"; key: string; name: string; detail: string }
  | {
      kind: "employee";
      key: string;
      id: string;
      name: string;
      detail: string;
      avatar: string | null;
    }
  | { kind: "manage"; key: string; name: string; detail: string };

export function EmployeeSelector() {
  const employees = useEmployeesStore((s) => s.employees);
  const loadEmployees = useEmployeesStore((s) => s.load);

  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const selectedEmployeeId = useChatStore((s) => s.selectedEmployeeId);
  const employeeIdBySession = useChatStore((s) => s.employeeIdBySession);
  const setViewMode = useChatStore((s) => s.setViewMode);
  /** 当前会话正在跑 Agent：运行中改员工会被拒绝，这里提前拦住 */
  const streaming = useChatStore((s) =>
    s.currentSessionId ? !!s.streamingBySession[s.currentSessionId] : false,
  );

  /** 会话已开始：员工随会话固定，与 Agent 一致 */
  const locked = currentSessionId !== null;

  /**
   * 已开会话优先读前端快照（会话刚创建、列表还没刷新），
   * 其次读主进程返回的 Session.employeeId（重启 / 切换旧会话）。
   */
  const employeeId = currentSessionId
    ? (employeeIdBySession[currentSessionId] ??
      sessions.find((session) => session.id === currentSessionId)?.employeeId ??
      null)
    : selectedEmployeeId;
  const selected = employees.find((item) => item.id === employeeId);
  /** 只允许选择已启用的员工 */
  const enabledEmployees = employees.filter((item) => item.enabled);

  const [open, setOpen] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  /** 行顺序与工作区菜单一致：解绑（仅已绑定时）→ 员工 → 管理 */
  const rows: EmployeeRow[] = [];
  if (employeeId) {
    rows.push({
      kind: "none",
      key: "employee:none",
      name: "不使用数字员工",
      detail: "直接使用 Agent 的全局配置",
    });
  }
  for (const employee of enabledEmployees) {
    rows.push({
      kind: "employee",
      key: `employee:${employee.id}`,
      id: employee.id,
      name: employee.name,
      detail: employee.role || "数字员工",
      avatar: employee.avatar,
    });
  }
  rows.push({
    kind: "manage",
    key: "employee:manage",
    name: "管理数字员工…",
    detail: "新建 / 编辑员工与能力绑定",
  });

  // 员工列表跨页共享；本页首次进入时拉一次，已加载过不会重复请求
  useEffect(() => {
    void loadEmployees();
  }, [loadEmployees]);

  // 切换会话时收起面板并刷新高亮，避免停留在上一个会话的选择态
  useEffect(() => {
    setOpen(false);
  }, [currentSessionId]);

  // 运行开始时收起已展开的菜单，避免在其中选到一半被拒绝
  useEffect(() => {
    if (streaming) setOpen(false);
  }, [streaming]);

  // 展开时：外部点击 / Esc 关闭
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

  // 打开时把高亮定位到当前选中项
  useEffect(() => {
    if (!open) return;
    const idx = rows.findIndex(
      (row) => row.kind === "employee" && row.id === employeeId,
    );
    setHoverIdx(idx < 0 ? 0 : idx);
    requestAnimationFrame(() => {
      itemRefs.current[idx]?.scrollIntoView({ block: "nearest" });
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const activate = (index: number) => {
    const row = rows[index];
    if (!row) return;
    setOpen(false);
    if (row.kind === "manage") {
      setViewMode("employees");
      return;
    }
    chooseEmployee(row.kind === "none" ? null : row.id);
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
      setHoverIdx((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHoverIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(hoverIdx);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const label = selected
    ? selected.name
    : employeeId
      ? "员工已失效"
      : "指定员工";

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        /* 与 AgentSelector 一致：会话开始后锁定，不再响应点击 */
        disabled={locked}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onKeyDown}
        title={
          locked
            ? selected
              ? `本次会话使用数字员工「${selected.name}」，会话开始后不可更换`
              : "本次会话未绑定数字员工；换人请新建会话"
            : selected
              ? `本次会话使用数字员工「${selected.name}」`
              : "选择本次会话使用的数字员工（可选）"
        }
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 ui-type-note text-text-muted outline-none transition-colors hover:bg-surface-hover hover:text-text ${
          locked ? "cursor-default" : ""
        } ${open ? "bg-surface-hover text-text" : ""}`}
      >
        {selected ? (
          <EmployeeAvatar employee={selected} size={16} />
        ) : (
          <UserRound
            className={`h-3.5 w-3.5 shrink-0 ${
              employeeId ? "text-error" : "text-accent"
            }`}
          />
        )}
        <span className="max-w-[120px] truncate font-medium text-text">
          {label}
        </span>
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

      {open && (
        <div
          role="menu"
          className="ui-dropdown-in ui-ring absolute bottom-full left-0 z-50 mb-2 flex max-h-72 w-[22rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl bg-surface p-1.5"
          style={{ boxShadow: "var(--c-shadow)" }}
        >
          <div className="flex items-center gap-1 px-2 pb-1 pt-0.5">
            <span className="min-w-0 flex-1 truncate ui-type-sub text-text-muted">
              选择数字员工
            </span>
            <span className="shrink-0 ui-type-sub text-text-muted/70">
              ↑↓ 选择
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((row, index) => {
              const manage = row.kind === "manage";
              if (manage) return null;
              const current =
                row.kind === "employee" && row.id === employeeId;
              const hovered = index === hoverIdx;
              return (
                <button
                  key={row.key}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  type="button"
                  role="menuitem"
                  aria-current={current ? "true" : undefined}
                  onMouseEnter={() => setHoverIdx(index)}
                  onClick={() => activate(index)}
                  title={`${row.name} · ${row.detail}`}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                    hovered
                      ? "bg-surface-hover text-text"
                      : current
                        ? "bg-surface-active text-text"
                        : "text-text-secondary hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  {row.kind === "none" ? (
                    <UserMinus className="h-4 w-4 shrink-0 text-text-muted" />
                  ) : (
                    <EmployeeAvatar
                      employee={{ name: row.name, avatar: row.avatar }}
                      size={16}
                    />
                  )}
                  <span className="max-w-[55%] shrink-0 truncate ui-type-body font-medium">
                    {row.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate ui-type-sub text-text-muted">
                    {row.detail}
                  </span>
                  {current && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                  )}
                </button>
              );
            })}

            {enabledEmployees.length === 0 && (
              <div className="px-2.5 py-2 ui-type-note leading-relaxed text-text-muted">
                {employees.length === 0
                  ? "还没有数字员工，先到「数字员工」页面创建。"
                  : "没有已启用的数字员工，请先在「数字员工」页面启用。"}
              </div>
            )}
          </div>

          {/* 管理项固定在底部，行样式与普通条目一致 */}
          <div className="my-1 h-px bg-border" />
          {rows.map((row, index) => {
            if (row.kind !== "manage") return null;
            const hovered = index === hoverIdx;
            return (
              <button
                key={row.key}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitem"
                onMouseEnter={() => setHoverIdx(index)}
                onClick={() => activate(index)}
                title={`${row.name} · ${row.detail}`}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                  hovered
                    ? "bg-surface-hover text-text"
                    : "text-text-secondary hover:bg-surface-hover hover:text-text"
                }`}
              >
                <Settings2 className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="max-w-[55%] shrink-0 truncate ui-type-body font-medium">
                  {row.name}
                </span>
                <span className="min-w-0 flex-1 truncate ui-type-sub text-text-muted">
                  {row.detail}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
