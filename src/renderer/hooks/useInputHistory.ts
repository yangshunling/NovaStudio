/**
 * 输入框发送历史（↑ / ↓ 翻找已发过的消息）
 *
 * 像 Claude Code / shell 一样：在输入框里按 ↑ 逐条回退到此前发过的正文，
 * 按 ↓ 往回走；翻过最新一条后恢复正在编辑的草稿，Esc 也直接还原草稿。
 *
 * 几个刻意的取舍：
 * - 跨会话共享：多数时候"上次问过的问题"发生在新会话里，按会话切分会找不到。
 *   历史落在 localStorage（只存用户亲手输入的正文，不含 @ 引用说明），重启仍在。
 * - ↑ 只在光标位于首行时接管，多行输入里首先仍是移动光标；↓ 同理只看末行。
 * - 进入历史前先暂存当前草稿，翻回底部时原样还回去，不丢未发送内容。
 * - 有选区时不拦截，交给 textarea 原生行为（Shift+↑ 扩选等）。
 */

import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

const STORAGE_KEY = "nova-prompt-history";
/** 保留条数：足够翻回很久以前，又不至于让 localStorage 无限膨胀 */
const MAX_ENTRIES = 200;

/**
 * 模块级单例：输入框卸载 / 会话切换不会丢内存态；
 * localStorage 不可用时（隐私模式等）退化为仅本次运行有效。
 */
let entriesCache: string[] | null = null;

function loadEntries(): string[] {
  if (entriesCache) return entriesCache;
  let parsed: unknown = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // 内容损坏或存储不可用：从空历史开始
  }
  entriesCache = Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
  entriesCache.length = Math.min(entriesCache.length, MAX_ENTRIES);
  return entriesCache;
}

function persistEntries(entries: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 写不进去只影响下次启动后的回放，内存历史仍可用
  }
}

interface UseInputHistoryOptions {
  /** 输入框当前值（受控） */
  value: string;
  setValue: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  /** 会话 / 草稿桶标识：切换会话时退出历史浏览，避免旧光标串到新会话 */
  scopeKey: string;
}

export function useInputHistory({
  value,
  setValue,
  textareaRef,
  scopeKey,
}: UseInputHistoryOptions) {
  /** -1 表示未在浏览历史（显示实时草稿）；>= 0 为历史下标（0 最新） */
  const cursorRef = useRef(-1);
  /** 进入历史浏览前的草稿，翻回底部时归还 */
  const stashRef = useRef("");

  const reset = useCallback(() => {
    cursorRef.current = -1;
    stashRef.current = "";
  }, []);

  useEffect(() => {
    reset();
  }, [scopeKey, reset]);

  /** 写入输入框并把光标落到末尾，方便接着改 */
  const commit = useCallback(
    (text: string) => {
      setValue(text);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      });
    },
    [setValue, textareaRef],
  );

  /**
   * 处理 ↑ / ↓ / Esc；返回 true 表示本次按键已被历史浏览消费，
   * 调用方应停止后续（例如 Enter 发送）处理。
   */
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      const key = event.key;
      if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "Escape") {
        return false;
      }
      // 带修饰键的箭头有自己的语义（Shift+↑ 扩选、Ctrl+↑ 跳段等）
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return false;
      }
      const textarea = event.currentTarget;
      // 有选区时交给原生行为，别把用户正在框选的内容换掉
      if (textarea.selectionStart !== textarea.selectionEnd) return false;

      if (key === "Escape") {
        if (cursorRef.current < 0) return false;
        event.preventDefault();
        const draft = stashRef.current;
        reset();
        commit(draft);
        return true;
      }

      const entries = loadEntries();
      if (entries.length === 0) return false;
      const caret = textarea.selectionStart ?? textarea.value.length;
      const text = textarea.value;

      if (key === "ArrowUp") {
        // 光标不在首行：优先当作普通的光标上移
        if (text.slice(0, caret).includes("\n")) return false;
        event.preventDefault();
        if (cursorRef.current < 0) {
          stashRef.current = value;
          cursorRef.current = 0;
        } else if (cursorRef.current < entries.length - 1) {
          cursorRef.current += 1;
        } else {
          // 已到最旧一条：保持内容不动，但仍然吃掉按键，避免光标跳到行首
          return true;
        }
        commit(entries[cursorRef.current]);
        return true;
      }

      // ArrowDown：没在浏览历史时不动它，正常移动光标
      if (cursorRef.current < 0) return false;
      // 光标不在末行：先让光标在历史正文里往下走
      if (text.slice(caret).includes("\n")) return false;
      event.preventDefault();
      if (cursorRef.current === 0) {
        const draft = stashRef.current;
        reset();
        commit(draft);
      } else {
        cursorRef.current -= 1;
        commit(entries[cursorRef.current]);
      }
      return true;
    },
    [value, commit, reset],
  );

  /** 记录一条已发送正文；连续重复只留一条 */
  const push = useCallback(
    (text: string) => {
      const entry = text.trim();
      reset();
      if (!entry) return;
      const entries = loadEntries();
      if (entries[0] === entry) return;
      entries.unshift(entry);
      if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
      persistEntries(entries);
    },
    [reset],
  );

  return { push, handleKeyDown };
}
