/**
 * 数字员工选择器 — 输入框旁、工作区右侧的紧凑下拉
 *
 * 语义：选择「这次任务由谁来答」。
 *   - 默认项「通用助手」→ 不绑定数字员工，直接走 Agent 全局配置
 *   - 选中员工 → 下一条消息使用该员工的提示词 / MCP / 技能 / 知识库
 *
 * 列表只展示已启用的员工：停用员工在运行时不可用，放进来只会让人选了才发现。
 * 选中后立即回显到触发器；已开会话的绑定写进该会话的快照，切换会话仍能还原。
 *
 * 行样式与「指定工作区」保持一致：单行、紧凑高度，名称与副标题同一行。
 * 员工不随会话锁定，随时可以换下一条消息的回答者；运行中切换也允许，
 * 只是本轮进程已按旧配置启动，新选择从下一轮生效。
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Settings2, UserRound } from "lucide-react";
import { useChatStore } from "../../stores/chat";
import { useEmployeesStore } from "../../stores/employees";
import { chooseEmployee, DEFAULT_ASSISTANT } from "../../lib/employee-switch";
import { EmployeeAvatar } from "../employees/EmployeeAvatar";
import claudeAvatarUrl from "../../assets/claude.png";

/** 默认回答者头像：与消息区左侧的 Agent 头像同一份图 */
function DefaultAnswererIcon({ size = 16 }: { size?: number }) {
  return (
    <img
      src={claudeAvatarUrl}
      alt={DEFAULT_ASSISTANT.name}
      width={size}
      height={size}
      draggable={false}
      className="shrink-0 rounded-full object-cover"
    />
  );
}

/** 弹窗里的一行，字段对齐工作区菜单的「图标 + 名称 + 副标题 + 当前标记」 */
type EmployeeRow =
  | { kind: "default"; key: string; name: string; detail: string }
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
  /** 当前会话正在跑 Agent：允许切换，但只对下一轮生效，用于给用户说明 */
  const streaming = useChatStore((s) =>
    s.currentSessionId ? !!s.streamingBySession[s.currentSessionId] : false,
  );

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

  /**
   * 行顺序：默认回答者 → 员工 → 管理。
   * 默认项始终在，新建会话没有绑定员工时它就是当前项。
   */
  const rows: EmployeeRow[] = [
    {
      kind: "default",
      key: "employee:default",
      name: DEFAULT_ASSISTANT.name,
      detail: DEFAULT_ASSISTANT.detail,
    },
  ];
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
    chooseEmployee(row.kind === "default" ? null : row.id);
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
      : DEFAULT_ASSISTANT.name;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onKeyDown}
        title={
          selected
            ? `下一条消息由「${selected.name}」回答`
            : employeeId
              ? "绑定的数字员工已失效，请重新选择"
              : `下一条消息由 ${DEFAULT_ASSISTANT.name} 回答（默认）`
        }
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 ui-type-note text-text-muted outline-none transition-colors hover:bg-surface-hover hover:text-text ${
          open ? "bg-surface-hover text-text" : ""
        }`}
      >
        {selected ? (
          <EmployeeAvatar employee={selected} size={16} />
        ) : employeeId ? (
          <UserRound className="h-3.5 w-3.5 shrink-0 text-error" />
        ) : (
          <DefaultAnswererIcon />
        )}
        <span className="max-w-[120px] truncate font-medium text-text">
          {label}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="ui-dropdown-in ui-ring absolute bottom-full left-0 z-50 mb-2 flex max-h-72 w-[22rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl bg-surface p-1.5"
          style={{ boxShadow: "var(--c-shadow)" }}
        >
          <div className="flex items-center gap-1 px-2 pb-1 pt-0.5">
            <span className="min-w-0 flex-1 truncate ui-type-sub text-text-muted">
              {streaming ? "本轮运行中，切换从下一轮生效" : "下一条消息由谁回答"}
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
                row.kind === "default"
                  ? employeeId === null
                  : row.kind === "employee" && row.id === employeeId;
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
                  {row.kind === "default" ? (
                    <DefaultAnswererIcon />
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
