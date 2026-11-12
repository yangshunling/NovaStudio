/**
 * 工作区快捷切换（#）
 *
 * 在输入框里输入 `#` 后列出本机登记的工作区：
 *   1. 行首或空格后输入 # → 弹出工作区列表
 *   2. 继续输入 → 按名称 / 路径过滤
 *   3. ↑↓ 导航，Enter / Tab 确认，Esc / 外部点击关闭
 *   4. 选中后直接切换当前会话的工作区；已产生消息的会话会先确认
 *
 * 列表本身与输入框旁的「指定工作区」下拉共用 WorkspaceMenuPanel：
 * 条目、排序、「管理工作区…」入口与行样式完全一致，这里只负责 `#` 的
 * 触发、过滤与键盘处理。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../../stores/chat";
import { switchWorkspace } from "../../lib/workspace-switch";
import {
  buildWorkspaceItems,
  openWorkspaceManager,
  useWorkspaceDefaultCwd,
  type WorkspaceMenuItem,
} from "./WorkspaceMenu";

interface UseWorkspacePickerOpts {
  /** 会话切换时关闭弹窗 */
  draftKey: string;
  input: string;
  setInput: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}

export function useWorkspacePicker({
  draftKey,
  input,
  setInput,
  textareaRef,
}: UseWorkspacePickerOpts) {
  const projects = useChatStore((s) => s.projects);
  const currentProjectId = useChatStore((s) => s.currentProjectId);
  const defaultCwd = useWorkspaceDefaultCwd();

  const [query, setQuery] = useState<string | null>(null);
  const [start, setStart] = useState(-1);
  const [hoverIdx, setHoverIdx] = useState(0);
  const pendingCursorRef = useRef<number | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  const active = query !== null;

  const entries = useMemo<WorkspaceMenuItem[]>(() => {
    const all = buildWorkspaceItems({ projects, currentProjectId, defaultCwd });
    const keyword = (query ?? "").trim().toLowerCase();
    if (!keyword) return all;
    // 管理入口始终保留；过滤只作用于工作区本身
    return all.filter(
      (item) =>
        item.kind === "manage" ||
        item.name.toLowerCase().includes(keyword) ||
        (item.title ?? item.detail).toLowerCase().includes(keyword),
    );
  }, [projects, currentProjectId, defaultCwd, query]);

  useEffect(() => {
    setHoverIdx(0);
  }, [entries]);

  useEffect(() => {
    if (active) itemRefs.current[hoverIdx]?.scrollIntoView({ block: "nearest" });
  }, [hoverIdx, active]);

  // 编程式修改 input 后恢复光标（与 @ 选择器一致）
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

  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popupRef.current &&
        !popupRef.current.contains(target) &&
        textareaRef.current &&
        !textareaRef.current.contains(target)
      ) {
        setQuery(null);
        setStart(-1);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [active, textareaRef]);

  const close = useCallback(() => {
    setQuery(null);
    setStart(-1);
  }, []);

  // 切换会话时关闭，避免旧弹窗跟着草稿进入另一个上下文
  useEffect(() => {
    close();
  }, [draftKey, close]);

  /** 用 replacement 替换当前 `#query`；eatSpace 会顺带吞掉一个连续空格 */
  const replaceQuery = useCallback(
    (replacement: string, eatSpace = false) => {
      const ta = textareaRef.current;
      const cursor = ta?.selectionStart ?? input.length;
      if (cursor < start) {
        close();
        return;
      }
      const before = input.slice(0, start);
      let after = input.slice(cursor);
      if (eatSpace && after.startsWith(" ")) after = after.slice(1);
      setInput(before + replacement + after);
      pendingCursorRef.current = before.length + replacement.length;
    },
    [input, start, setInput, textareaRef, close],
  );

  const selectEntry = useCallback(
    (entry: WorkspaceMenuItem) => {
      // 管理工作区不改变当前上下文：清掉 #query 后直接跳转
      if (entry.kind === "manage") {
        replaceQuery("", true);
        close();
        openWorkspaceManager();
        return;
      }
      // 先收起列表；确认框 / 运行中提示由 switchWorkspace 统一处理
      close();
      void switchWorkspace(entry.id).then((result) => {
        /*
         * 只有真的切换、或目标本来就是当前工作区时才清掉正文里的
         * `#query`。取消确认 / 运行中被拒时保留用户输入，方便重新选择。
         */
        if (result === "switched" || result === "unchanged") {
          replaceQuery("", true);
        }
      });
    },
    [replaceQuery, close],
  );

  /** 只负责检测 # 触发，输入本身由 @ 选择器统一写入 */
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const cursor = e.target.selectionStart ?? value.length;
      const before = value.slice(0, cursor);
      const match = before.match(/(?:^|\s)#([^\s]*)$/);
      if (match) {
        const next = match[1];
        setStart(cursor - next.length - 1);
        setQuery(next);
      } else {
        close();
      }
    },
    [close],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!active) return false;

      if (e.key === "ArrowDown") {
        if (entries.length === 0) return false;
        e.preventDefault();
        setHoverIdx((i) => Math.min(i + 1, entries.length - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        if (entries.length === 0) return false;
        e.preventDefault();
        setHoverIdx((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const entry = entries[hoverIdx];
        if (entry) {
          e.preventDefault();
          selectEntry(entry);
          return true;
        }
        close();
        return false;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return true;
      }
      return false;
    },
    [active, entries, hoverIdx, selectEntry, close],
  );

  const emptyHint =
    projects.length === 0
      ? "还没有工作区，先到「工作区」页面登记一个本地目录。"
      : query
        ? `没有匹配「${query}」的工作区`
        : "没有可切换的工作区";

  return {
    active,
    entries,
    hoverIdx,
    emptyHint,
    popupRef,
    itemRefs,
    handleChange,
    handleKeyDown,
    setHoverIdx,
    selectEntry,
  };
}
