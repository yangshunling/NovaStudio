/**
 * 提示词选择器 — 输入框旁的常用提示词入口
 *
 * 提示词库如果只能「复制 → 切页 → 粘贴」，核心闭环就断了。这里把提示词
 * 直接接回输入框：点击后在输入区上方展开可搜索列表，选中即插入正文，
 * 由用户确认后再发送（不自动发送，避免误触）。
 *
 * 数据按需拉取：每次打开都重新读一次，保证刚在提示词页改过的内容立即可见。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MessageSquareText, Search } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { useChatStore } from "../../stores/chat";
import type { PromptItem } from "@shared/types";

export function PromptPicker({ onPick }: { onPick: (content: string) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PromptItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hoverIdx, setHoverIdx] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const setViewMode = useChatStore((s) => s.setViewMode);

  // ---- 打开时拉取列表（每次都取最新，避免读到旧缓存）----
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);

    ipc
      .listPrompts()
      .then((list) => {
        if (cancelled) return;
        setItems(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(toMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [open, reloadKey]);

  // ---- 打开时聚焦搜索框；关闭时重置查询 ----
  useEffect(() => {
    if (!open) {
      setQuery("");
      setHoverIdx(0);
      setError(null);
      return;
    }
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // ---- 外部点击 / Esc 关闭 ----
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const list = items ?? [];
    const keyword = query.trim().toLowerCase();
    if (!keyword) return list;
    return list.filter((item) =>
      [item.title, item.content, item.tags.join(" ")].some((value) =>
        value.toLowerCase().includes(keyword),
      ),
    );
  }, [items, query]);

  // ---- 过滤结果变化后重置高亮 ----
  useEffect(() => {
    setHoverIdx(0);
  }, [query]);

  // ---- 高亮项滚入可视区 ----
  useEffect(() => {
    if (!open) return;
    itemRefs.current[hoverIdx]?.scrollIntoView({ block: "nearest" });
  }, [hoverIdx, open]);

  const pick = (item: PromptItem | undefined) => {
    if (!item) return;
    setOpen(false);
    onPick(item.content);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      if (filtered.length === 0) return;
      event.preventDefault();
      setHoverIdx((index) => Math.min(index + 1, filtered.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      if (filtered.length === 0) return;
      event.preventDefault();
      setHoverIdx((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pick(filtered[hoverIdx]);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title="插入常用提示词"
        aria-label="插入常用提示词"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`ui-btn-round ui-icon-action flex size-icon-btn shrink-0 items-center justify-center rounded-full transition-colors ${
          open ? "text-accent" : "text-text-muted hover:text-text"
        }`}
      >
        <MessageSquareText className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="选择提示词"
          className="ui-dropdown-in ui-glass-strong ui-ring absolute bottom-full right-0 z-50 mb-2 flex w-[min(22rem,calc(100vw-2rem))] flex-col rounded-xl p-1.5"
          style={{ boxShadow: "var(--c-shadow)" }}
        >
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-input-bg px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="搜索标题 / 正文 / 标签"
              className="min-w-0 flex-1 bg-transparent text-body text-text placeholder-text-muted outline-none"
            />
          </div>

          <div className="ui-scroll-hidden mt-1 max-h-72 overflow-y-auto">
            {items === null && !error ? (
              <div className="flex items-center gap-2 px-2.5 py-3 text-meta text-text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在加载提示词
              </div>
            ) : error ? (
              <div className="px-2.5 py-3">
                <p className="text-meta leading-relaxed text-error">{error}</p>
                <button
                  type="button"
                  onClick={() => setReloadKey((value) => value + 1)}
                  className="mt-2 rounded-full border border-border px-2.5 py-1 text-caption text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                >
                  重新加载
                </button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-2.5 py-3 text-meta leading-relaxed text-text-muted">
                {(items?.length ?? 0) === 0
                  ? "还没有提示词。先到「提示词」页新建一条。"
                  : "没有匹配的提示词"}
              </div>
            ) : (
              filtered.map((item, index) => (
                <button
                  key={item.id}
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  type="button"
                  onMouseEnter={() => setHoverIdx(index)}
                  onClick={() => pick(item)}
                  className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    index === hoverIdx ? "bg-surface-hover" : ""
                  }`}
                >
                  <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate text-body font-medium text-text">
                        {item.title}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-caption text-text-muted">
                      {firstLine(item.content)}
                    </span>
                    {item.tags.length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {item.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-surface-hover px-1.5 text-micro text-text-muted"
                          >
                            #{tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="mt-1 border-t border-border/60 pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setViewMode("prompts");
              }}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-caption text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
            >
              管理提示词
              <span aria-hidden>→</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 列表里只展示正文第一行，避免长正文把弹层撑乱 */
function firstLine(content: string): string {
  return content.split("\n").find((line) => line.trim())?.trim() ?? "暂无内容";
}