/**
 * 文件提及 (@ mention) — 输入框中 @ 触发文件选择弹窗
 *
 * 交互：
 *   1. 行首或空格后输入 @ → 弹出当前项目目录文件列表
 *   2. 继续输入字符 → 客户端过滤匹配
 *   3. 输入 / → 进入子目录（@src/ 列出 src 目录内容）
 *   4. ↑↓ 导航、Enter 确认（文件=插入路径，目录=进入子目录）
 *   5. Tab 强制插入（无论文件或目录）、Esc / 外部点击 → 关闭
 *
 * 文件列表通过 IPC 从主进程读取（带缓存），过滤在渲染端完成。
 */

import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { FileEntry } from "@shared/types";
import { FileTypeIcon } from "./ui/FileTypeIcon";
import { FolderTypeIcon } from "./ui/FolderTypeIcon";

// ============================================================================
// Hook
// ============================================================================

interface UseFileMentionOpts {
  cwd: string;
  input: string;
  setInput: (v: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}

export function useFileMention({
  cwd,
  input,
  setInput,
  textareaRef,
}: UseFileMentionOpts) {
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(-1);
  const [rawItems, setRawItems] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(0);
  const [references, setReferences] = useState<FileEntry[]>([]);
  const loadedSubPathRef = useRef<string | null>(null);
  const cacheRef = useRef<Record<string, FileEntry[]>>({});
  const pendingCursorRef = useRef<number | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const active = mentionQuery !== null && cwd !== "";

  // ---- 解析 query 为 subPath + filter ----
  const { subPath, filter } = useMemo(() => {
    if (mentionQuery === null) return { subPath: "", filter: "" };
    const lastSlash = mentionQuery.lastIndexOf("/");
    if (lastSlash >= 0) {
      return {
        subPath: mentionQuery.slice(0, lastSlash),
        filter: mentionQuery.slice(lastSlash + 1),
      };
    }
    return { subPath: "", filter: mentionQuery };
  }, [mentionQuery]);

  // ---- 子目录变化时从主进程加载文件 ----
  useEffect(() => {
    if (mentionQuery === null || !cwd) {
      setRawItems([]);
      loadedSubPathRef.current = null;
      return;
    }
    if (subPath === loadedSubPathRef.current) return;
    loadedSubPathRef.current = subPath;

    const cached = cacheRef.current[subPath];
    if (cached) {
      setRawItems(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    ipc.listFiles(cwd, subPath || undefined).then((entries) => {
      if (cancelled) return;
      cacheRef.current[subPath] = entries;
      setRawItems(entries);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setRawItems([]);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [mentionQuery, subPath, cwd]);

  // ---- 切换项目时清空缓存 ----
  useEffect(() => {
    cacheRef.current = {};
    loadedSubPathRef.current = null;
    setMentionQuery(null);
    setRawItems([]);
  }, [cwd]);

  // ---- 客户端过滤 ----
  const items = useMemo(() => {
    if (!filter) return rawItems;
    const lower = filter.toLowerCase();
    return rawItems.filter((e) => e.name.toLowerCase().includes(lower));
  }, [rawItems, filter]);

  // ---- items 变化时重置 hover ----
  useEffect(() => {
    setHoverIdx(0);
  }, [items]);

  // ---- hover 项滚入视口 ----
  useEffect(() => {
    if (active) {
      itemRefs.current[hoverIdx]?.scrollIntoView({ block: "nearest" });
    }
  }, [hoverIdx, active]);

  // ---- 编程式修改 input 后恢复光标 ----
  useEffect(() => {
    if (pendingCursorRef.current !== null) {
      const ta = textareaRef.current;
      if (ta) {
        ta.selectionStart = pendingCursorRef.current;
        ta.selectionEnd = pendingCursorRef.current;
        ta.focus();
      }
      pendingCursorRef.current = null;
    }
  });

  // ---- 外部点击关闭 ----
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popupRef.current && !popupRef.current.contains(target) &&
        textareaRef.current && !textareaRef.current.contains(target)
      ) {
        setMentionQuery(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [active, textareaRef]);

  // ---- 插入 @path（close=true 插入文件，close=false 进入目录）----
  const insertMention = useCallback(
    (entry: FileEntry, close: boolean) => {
      const relativePath = entry.relativePath;
      const ta = textareaRef.current;
      const cursor = ta?.selectionStart ?? input.length;
      if (cursor < mentionStart) {
        setMentionQuery(null);
        return;
      }
      const before = input.slice(0, mentionStart);
      const rawAfter = input.slice(cursor);

      if (close) {
        // 文件引用改为标签承载，正文里不再保留 @路径；同时吞掉一个连续空格。
        const after = rawAfter.startsWith(" ") ? rawAfter.slice(1) : rawAfter;
        setInput(before + after);
        pendingCursorRef.current = before.length;
        setReferences((current) =>
          current.some((item) => item.relativePath === relativePath)
            ? current
            : [...current, entry],
        );
      } else {
        const insertion = `@${relativePath}`;
        setInput(before + insertion + rawAfter);
        pendingCursorRef.current = before.length + insertion.length;
        setMentionQuery(`${relativePath}/`);
      }
      if (close) {
        setMentionQuery(null);
        setMentionStart(-1);
      }
    },
    [input, mentionStart, setInput, textareaRef],
  );

  // ---- textarea onChange：检测 @ mention ----
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const cursor = e.target.selectionStart ?? value.length;
      setInput(value);

      const before = value.slice(0, cursor);
      const match = before.match(/(?:^|\s)@([^\s]*)$/);
      if (match && cwd) {
        const query = match[1];
        setMentionStart(cursor - query.length - 1);
        setMentionQuery(query);
      } else {
        setMentionQuery(null);
        setMentionStart(-1);
      }
    },
    [cwd, setInput],
  );

  // ---- textarea onKeyDown：导航 / 选择 / 关闭 ----
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!active) return false;

      if (e.key === "ArrowDown") {
        if (items.length === 0) return false;
        e.preventDefault();
        setHoverIdx((i) => Math.min(i + 1, items.length - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        if (items.length === 0) return false;
        e.preventDefault();
        setHoverIdx((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === "Enter") {
        const entry = items[hoverIdx];
        if (entry) {
          e.preventDefault();
          if (entry.isDirectory) {
            insertMention(entry, false);
          } else {
            insertMention(entry, true);
          }
          return true;
        }
        setMentionQuery(null);
        return false;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const entry = items[hoverIdx];
        if (entry) insertMention(entry, true);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return true;
      }
      return false;
    },
    [active, items, hoverIdx, insertMention],
  );

  // ---- 点击选择（目录=进入，文件=插入）----
  const selectEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.isDirectory) {
        insertMention(entry, false);
      } else {
        insertMention(entry, true);
      }
    },
    [insertMention],
  );

  const removeReference = useCallback(
    (relativePath: string) => {
      setReferences((current) =>
        current.filter((entry) => entry.relativePath !== relativePath),
      );
    },
    [],
  );

  const clearReferences = useCallback(() => {
    setReferences([]);
  }, []);

  return {
    active,
    items,
    hoverIdx,
    loading,
    popupRef,
    itemRefs,
    references,
    handleChange,
    handleKeyDown,
    setHoverIdx,
    selectEntry,
    removeReference,
    clearReferences,
  };
}

// ============================================================================
// Popup
// ============================================================================

export function FileMentionPopup({
  items,
  hoverIdx,
  loading,
  onHover,
  onSelect,
  popupRef,
  itemRefs,
}: {
  items: FileEntry[];
  hoverIdx: number;
  loading: boolean;
  onHover: (idx: number) => void;
  onSelect: (entry: FileEntry) => void;
  popupRef: React.RefObject<HTMLDivElement>;
  itemRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
}) {
  return (
    <div
      ref={popupRef}
      className="ui-dropdown-in ui-glass-strong ui-ring absolute bottom-full left-0 z-50 mb-2 max-h-60 w-80 overflow-y-auto rounded-xl p-1.5"
      style={{ boxShadow: "var(--c-shadow)" }}
    >
      {loading && items.length === 0 ? (
        <div className="flex items-center gap-2 px-2.5 py-2 text-meta text-text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          加载文件列表...
        </div>
      ) : items.length === 0 ? (
        <div className="px-2.5 py-2 text-meta text-text-muted">无匹配文件</div>
      ) : (
        <>
          <div className="px-2.5 pb-1 pt-0.5 text-caption text-text-muted">
            选择文件
          </div>
          {items.map((entry, i) => (
            <button
              key={entry.relativePath}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(entry)}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                i === hoverIdx ? "bg-surface-hover" : ""
              }`}
            >
              {entry.isDirectory ? (
                <FolderTypeIcon />
              ) : (
                <FileTypeIcon name={entry.name} />
              )}
              <span className="min-w-0 flex-1 truncate text-body text-text">
                {entry.name}
              </span>
              {entry.isDirectory && (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
              )}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
