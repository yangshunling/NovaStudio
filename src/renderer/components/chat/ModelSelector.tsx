/**
 * 模型选择器 — 输入框旁的紧凑下拉
 *
 * 模型和权限一样，是「本次任务怎么跑」的运行参数：同一会话里换个任务，
 * 可能需要长上下文模型或更便宜的快速模型。放在提问处随手切换最顺手。
 *
 * 语义：
 *   - 已开会话：写会话记录，下一轮运行生效（不影响正在跑的进程）；
 *   - 新会话：只记在草稿里，首条消息创建会话时一并落库；
 *   - 「跟随 Agent 默认」对应空值，不传 `--model`，由 CLI 读取本机配置。
 *
 * 只改会话记录，不写回 settings.json：全局默认仍然由 Agent 配置页维护。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, ChevronDown } from "lucide-react";
import { useChatStore } from "../../stores/chat";
import { ipc } from "../../lib/ipc";
import {
  useAgentSettings,
  useAgentSettingsStore,
} from "../../stores/agentSettings";
import { toast } from "../../stores/toast";
import { errorMessage } from "@shared/error";
import type { AgentModelOption } from "@shared/contracts/agent";

/** 设置里的模型条目 → CLI 认识的完整 ID */
function entryLabel(entry: { name: string; context: string } | null): string {
  if (!entry?.name) return "";
  return entry.context ? `${entry.name}[${entry.context}]` : entry.name;
}

export function ModelSelector() {
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const selectedAgentId = useChatStore((s) => s.selectedAgentId);
  const draftModel = useChatStore((s) => s.selectedModel);
  const setModel = useChatStore((s) => s.setModel);

  const session = currentSessionId
    ? sessions.find((item) => item.id === currentSessionId)
    : undefined;
  const agentId = session?.agentId ?? selectedAgentId;
  // 已开会话读会话记录；新会话读草稿
  const value = currentSessionId
    ? (session?.model ?? null)
    : draftModel;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 默认模型名常驻工具栏：由共享快照驱动，配置保存后立即更新
  const settings = useAgentSettings(agentId);
  const [models, setModels] = useState<AgentModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 接入点没有模型列表接口：中性提示，不是错误 */
  const [note, setNote] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);

  const defaultLabel = useMemo(
    () => entryLabel(settings?.defaultModel ?? null),
    [settings],
  );

  // 切换会话时收起面板，避免停留在上一个会话的选择态
  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [currentSessionId]);

  // 外部点击 / Esc 关闭
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

  /**
   * 展开时才拉配置与模型列表：聊天页不需要为每个会话预先发请求。
   * 列表失败不阻断使用——仍可手动输入模型 ID。
   */
  const load = useCallback(async () => {
    if (!agentId) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    setNote(null);
    try {
      // 展开时强制刷新一次：用户可能刚在配置页改过 Base URL / Key
      const view = await useAgentSettingsStore
        .getState()
        .load(agentId, { force: true });
      if (requestId !== requestRef.current) return;
      if (!view) {
        throw new Error(
          useAgentSettingsStore.getState().error[agentId] ?? "读取 Agent 配置失败",
        );
      }
      try {
        const result = await ipc.listAgentModels({
          agentId,
          baseUrl: view.baseUrl,
          apiKey: view.apiKey,
          authMode: view.authMode,
          customHeaders: view.customHeaders,
        });
        if (requestId !== requestRef.current) return;
        setModels(result.models);
        setNote(result.unsupported ?? null);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setModels([]);
        setNote(null);
        setError(errorMessage(err));
      }
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [agentId]);

  const openMenu = () => {
    setOpen(true);
    setQuery("");
    setHoverIdx(0);
    void load();
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const activate = async (next: string | null) => {
    setOpen(false);
    setQuery("");
    if (next === value) return;
    try {
      await setModel(next);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  /** 过滤后的候选：空查询展示全部；有查询时做包含匹配 */
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return models;
    return models.filter(
      (item) =>
        item.id.toLowerCase().includes(keyword) ||
        item.displayName?.toLowerCase().includes(keyword),
    );
  }, [models, query]);

  const trimmed = query.trim();
  const exactMatch = filtered.some((item) => item.id === trimmed);
  const customCandidate = trimmed && !exactMatch ? trimmed : null;

  /** 可键盘选择的条目：0 = 跟随默认，1..n = 模型，最后 = 自定义 */
  const rows = useMemo(
    () => [
      { id: null as string | null, label: "跟随 Agent 默认", hint: defaultLabel },
      ...filtered.map((item) => ({
        id: item.id,
        label:
          item.displayName && item.displayName !== item.id
            ? `${item.displayName} (${item.id})`
            : item.id,
        hint: "",
      })),
      ...(customCandidate
        ? [{ id: customCandidate, label: `使用「${customCandidate}」`, hint: "自定义模型 ID" }]
        : []),
    ],
    [filtered, customCandidate, defaultLabel],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHoverIdx((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHoverIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[hoverIdx];
      if (row) void activate(row.id);
    }
  };

  // 当前值不在候选里（例如旧会话用了已下线的模型）：补一行，避免显示为空
  const valueInList =
    value === null ||
    models.some((item) => item.id === value) ||
    (customCandidate !== null && customCandidate === value);
  const currentLabel = value ?? (defaultLabel || "默认模型");

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        title={
          value
            ? `本会话模型：${value}（不写回 settings.json）`
            : `跟随 Agent 默认模型${defaultLabel ? `：${defaultLabel}` : ""}`
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`ui-toolbar-chip shrink-0 text-text-muted hover:bg-surface-hover hover:text-text ${
          open ? "bg-surface-hover text-text" : ""
        }`}
      >
        {/*
         * 小徽标比裸图标更像「模型槽位」：显式选过模型时点亮成 accent，
         * 跟随默认时保持中性，扫一眼就能看出本会话有没有覆盖全局配置。
         */}
        <span
          className={`flex size-badge shrink-0 items-center justify-center rounded-sm ring-1 ring-inset transition-colors ${
            value
              ? "bg-accent-soft text-accent ring-accent/25"
              : "bg-surface-hover text-text-muted ring-border/70"
          }`}
        >
          <Boxes className="h-icon-xs w-icon-xs" strokeWidth={2.2} />
        </span>
        <span className="min-w-0 truncate text-left font-medium text-text">
          {currentLabel}
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
          className="ui-dropdown-in ui-glass-strong ui-ring absolute bottom-full left-0 z-50 mb-2 w-dropdown-wide max-w-[calc(100vw-2rem)] rounded-xl p-1.5"
          style={{ boxShadow: "var(--c-shadow)" }}
        >
          <div className="px-2 pb-1.5 pt-1">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHoverIdx(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="搜索模型，或输入模型 ID 后回车"
              className="w-full rounded-md bg-surface-hover/60 px-2 py-1.5 ui-type-note text-text outline-none placeholder:text-text-muted"
            />
            {error && (
              <p className="mt-1 px-1 ui-type-sub text-text-muted">
                模型列表获取失败：{error}（可直接输入模型 ID）
              </p>
            )}
            {note && !error && (
              <p className="mt-1 px-1 ui-type-sub text-text-muted">
                {note}
              </p>
            )}
            {loading && (
              <p className="mt-1 px-1 ui-type-sub text-text-muted">
                正在获取模型列表…
              </p>
            )}
          </div>

          <div className="max-h-[19rem] overflow-y-auto">
            {rows.map((row, index) => {
              const active = row.id === value;
              const hovered = index === hoverIdx;
              return (
                <button
                  key={`${row.id ?? "__default"}__${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setHoverIdx(index)}
                  onClick={() => void activate(row.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                    hovered
                      ? "bg-surface-hover text-text"
                      : active
                        ? "bg-surface-active text-text"
                        : "text-text-secondary hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  <span
                    className={`min-w-0 flex-1 truncate ui-type-note font-medium ${
                      active ? "text-accent" : ""
                    }`}
                  >
                    {row.label}
                  </span>
                  {row.hint && (
                    <span className="shrink-0 ui-type-sub text-text-muted">
                      {row.hint}
                    </span>
                  )}
                </button>
              );
            })}
            {!valueInList && value && (
              <div className="px-2.5 py-1.5 ui-type-sub text-text-muted">
                当前使用：{value}（不在可用列表中）
              </div>
            )}
            {!loading && rows.length === 1 && !error && !note && (
              <div className="px-2.5 py-1.5 ui-type-sub text-text-muted">
                当前接入点没有返回模型列表
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
