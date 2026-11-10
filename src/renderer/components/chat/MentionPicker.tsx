/**
 * 引用选择器 (@ mention)
 *
 * 输入 @ 后先进入「引用类型」这一层，选中类型后再列出该类型下的条目：
 *   文件 / 工具（MCP） / 技能 / 提示词 / 知识库
 *
 * 交互：
 *   1. 行首或空格后输入 @ → 弹出引用类型列表
 *   2. 输入字符 → 在类型层过滤；选中类型后改为过滤该类型下的条目
 *   3. 文件类型保留目录下钻：继续输入 / 或选中目录进入子目录
 *   4. ↑↓ 导航，Enter 确认；Backspace 在空查询时返回上一级
 *   5. Tab 强制选择、Esc / 外部点击关闭
 *
 * 选择结果：
 *   - 文件 / 工具 / 技能 / 知识库 → 作为引用标签挂在输入框上方，发送时转成提示词
 *   - 提示词 → 正文直接插入输入框，由用户确认后发送
 *
 * 文件列表通过 IPC 从主进程读取（带缓存）；工具 / 技能 / 知识库复用
 * assets store 的扫描结果；提示词每次进入分类时重新读取，保证刚改过就能看到。
 */

import { useState, useEffect, useRef, useMemo, useCallback, } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronLeft, ChevronRight, FileText, Library, MessageSquareText, Sparkles, Wrench } from "lucide-react";
import {
  useKnowledgeBasesStore,
  useMcpServersStore,
  useSkillsStore,
} from "../../stores/assets";
import { ipc } from "../../lib/ipc";
import type { FileEntry, PromptItem } from "@shared/types";
import { FileTypeIcon } from "../ui/FileTypeIcon";
import { FolderTypeIcon } from "../ui/FolderTypeIcon";
import { Spinner } from "../ui/Spinner";

// ============================================================================
// 类型与常量
// ============================================================================

export type MentionCategory = "file" | "tool" | "skill" | "prompt" | "knowledge";

/** 发送时会转成提示词的引用（提示词正文直接插入，不走标签） */
export interface MentionReference {
  key: string;
  category: Exclude<MentionCategory, "prompt">;
  name: string;
  detail: string;
  promptText: string;
}

/** 弹窗里的一行：类型行或具体条目 */
export interface MentionEntry {
  key: string;
  category: MentionCategory;
  name: string;
  /** 副标题：文件路径 / 资产描述 / 提示词摘要 */
  detail: string;
  /** 文件：是否目录 */
  isDirectory?: boolean;
  /** 文件：相对工作区根的路径 */
  relativePath?: string;
  /** 提示词：正文，选中后直接插入输入框 */
  content?: string;
  /** 非提示词条目：发送时追加到 prompt 的文本 */
  promptText?: string;
}

const CATEGORY_META: Record<
  MentionCategory,
  { label: string; description: string; icon: LucideIcon }
> = {
  file: { label: "文件", description: "工作区中的文件与目录", icon: FileText },
  tool: { label: "工具", description: "已接入的 MCP 服务", icon: Wrench },
  skill: { label: "技能", description: "已安装的 skill 技能", icon: Sparkles },
  prompt: {
    label: "提示词",
    description: "常用提示词模板",
    icon: MessageSquareText,
  },
  knowledge: {
    label: "知识库",
    description: "本地知识库资料",
    icon: Library,
  },
};

const CATEGORY_ORDER: readonly MentionCategory[] = [
  "file",
  "tool",
  "skill",
  "prompt",
  "knowledge",
];

function isMentionCategory(value: string): value is MentionCategory {
  return Object.prototype.hasOwnProperty.call(CATEGORY_META, value);
}

/** 提示词正文压成单行摘要，避免长文把列表行撑开 */
function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

// ============================================================================
// Hook
// ============================================================================

interface UseMentionOpts {
  /** 草稿归属（会话 id / 新会话桶）；切换时清空引用 */
  draftKey: string;
  /** 绑定的工作区 id；空字符串表示未绑定，文件分类不可用 */
  projectId: string;
  input: string;
  setInput: (v: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}

export function useMention({
  draftKey,
  projectId,
  input,
  setInput,
  textareaRef,
}: UseMentionOpts) {
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(-1);
  const [fileItems, setFileItems] = useState<FileEntry[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const [promptItems, setPromptItems] = useState<PromptItem[]>([]);
  const [promptLoading, setPromptLoading] = useState(false);
  const [references, setReferences] = useState<MentionReference[]>([]);
  const [hoverIdx, setHoverIdx] = useState(0);

  const loadedSubPathRef = useRef<string | null>(null);
  const cacheRef = useRef<Record<string, FileEntry[]>>({});
  const pendingCursorRef = useRef<number | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const promptRequestRef = useRef(0);

  // 资产 store：启动时已预热，进入分类时按需补一次加载
  const mcpServers = useMcpServersStore((s) => s.items);
  const mcpLoading = useMcpServersStore((s) => s.loading);
  const loadMcp = useMcpServersStore((s) => s.load);
  const skills = useSkillsStore((s) => s.items);
  const skillsLoading = useSkillsStore((s) => s.loading);
  const loadSkills = useSkillsStore((s) => s.load);
  const knowledgeBases = useKnowledgeBasesStore((s) => s.items);
  const knowledgeLoading = useKnowledgeBasesStore((s) => s.loading);
  const loadKnowledge = useKnowledgeBasesStore((s) => s.load);

  const active = mentionQuery !== null;

  // ---- 解析 query：`file/src/` → 分类 file、子目录 src ----
  const parsed = useMemo(() => {
    if (mentionQuery === null) {
      return { category: null as MentionCategory | null, filter: "", subPath: "" };
    }
    const slash = mentionQuery.indexOf("/");
    if (slash < 0) {
      return { category: null as MentionCategory | null, filter: mentionQuery, subPath: "" };
    }
    const key = mentionQuery.slice(0, slash);
    if (!isMentionCategory(key)) {
      // 不认识的分类前缀仍按类型层过滤，避免输入被吞
      return { category: null as MentionCategory | null, filter: mentionQuery, subPath: "" };
    }
    const rest = mentionQuery.slice(slash + 1);
    if (key === "file") {
      const lastSlash = rest.lastIndexOf("/");
      return {
        category: key,
        subPath: lastSlash >= 0 ? rest.slice(0, lastSlash) : "",
        filter: lastSlash >= 0 ? rest.slice(lastSlash + 1) : rest,
      };
    }
    return { category: key, filter: rest, subPath: "" };
  }, [mentionQuery]);

  // ---- 文件：子目录变化时从主进程加载（带缓存）----
  useEffect(() => {
    if (parsed.category !== "file" || !projectId) {
      setFileItems([]);
      loadedSubPathRef.current = null;
      return;
    }
    const subPath = parsed.subPath;
    if (subPath === loadedSubPathRef.current) return;
    loadedSubPathRef.current = subPath;

    const cached = cacheRef.current[subPath];
    if (cached) {
      setFileItems(cached);
      setFileLoading(false);
      return;
    }

    let cancelled = false;
    setFileLoading(true);
    ipc
      .listFiles(projectId, subPath || undefined)
      .then((entries) => {
        if (cancelled) return;
        cacheRef.current[subPath] = entries;
        setFileItems(entries);
        setFileLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFileItems([]);
        setFileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [parsed.category, parsed.subPath, projectId]);

  // ---- 工具 / 技能 / 知识库：进入分类时确保已加载 ----
  useEffect(() => {
    if (parsed.category === "tool") void loadMcp();
    else if (parsed.category === "skill") void loadSkills();
    else if (parsed.category === "knowledge") void loadKnowledge();
  }, [parsed.category, loadMcp, loadSkills, loadKnowledge]);

  // ---- 提示词：每次进入分类都重新读取，保证内容是最新的 ----
  useEffect(() => {
    if (!active || parsed.category !== "prompt") return;
    const requestId = ++promptRequestRef.current;
    setPromptLoading(true);
    ipc
      .listPrompts()
      .then((list) => {
        if (requestId !== promptRequestRef.current) return;
        setPromptItems(list);
      })
      .catch(() => {
        if (requestId !== promptRequestRef.current) return;
        setPromptItems([]);
      })
      .finally(() => {
        if (requestId === promptRequestRef.current) setPromptLoading(false);
      });
    return () => {
      // 关闭弹窗 / 切换分类后，旧请求的结果不再落盘
      promptRequestRef.current++;
    };
  }, [active, parsed.category]);

  // ---- 切换项目时清空缓存与引用：旧路径在新工作区里不存在 ----
  useEffect(() => {
    cacheRef.current = {};
    loadedSubPathRef.current = null;
    setMentionQuery(null);
    setMentionStart(-1);
    setFileItems([]);
    setReferences([]);
  }, [projectId]);

  // ---- 切换会话时清空引用，避免旧引用跟着草稿混进另一个上下文 ----
  useEffect(() => {
    setReferences([]);
    setMentionQuery(null);
    setMentionStart(-1);
    setFileItems([]);
    loadedSubPathRef.current = null;
    setHoverIdx(0);
  }, [draftKey]);

  // ---- 组装当前层的候选行 ----
  const entries = useMemo<MentionEntry[]>(() => {
    // 类型层
    if (!parsed.category) {
      const keyword = parsed.filter.trim().toLowerCase();
      return CATEGORY_ORDER.filter((key) => {
        if (!keyword) return true;
        const meta = CATEGORY_META[key];
        return (
          key.includes(keyword) ||
          meta.label.includes(keyword) ||
          meta.description.toLowerCase().includes(keyword)
        );
      }).map((key) => ({
        key: `category:${key}`,
        category: key,
        name: CATEGORY_META[key].label,
        detail: CATEGORY_META[key].description,
      }));
    }

    let list: MentionEntry[];
    switch (parsed.category) {
      case "file":
        list = fileItems.map((item) => ({
          key: `file:${item.relativePath}`,
          category: "file",
          name: item.name,
          detail: item.isDirectory ? item.relativePath : "",
          isDirectory: item.isDirectory,
          relativePath: item.relativePath,
          promptText: `@${item.relativePath}`,
        }));
        break;
      case "tool":
        list = mcpServers.map((server) => ({
          key: `tool:${server.id}`,
          category: "tool",
          name: server.name || server.slug,
          detail:
            server.description ||
            server.url ||
            server.command ||
            "MCP 服务",
          promptText: `请使用 MCP 服务「${server.name || server.slug}」中的工具。`,
        }));
        break;
      case "skill":
        list = skills
          .filter((skill) => skill.valid)
          .map((skill) => ({
            key: `skill:${skill.id}`,
            category: "skill",
            name: skill.name,
            detail: skill.description || skill.path,
            promptText: `请使用技能「${skill.name}」。`,
          }));
        break;
      case "prompt":
        list = promptItems.map((item) => ({
          key: `prompt:${item.id}`,
          category: "prompt",
          name: item.title,
          detail: snippet(item.content),
          content: item.content,
        }));
        break;
      case "knowledge":
        list = knowledgeBases.map((asset) => ({
          key: `knowledge:${asset.id}`,
          category: "knowledge",
          name: asset.name,
          detail:
            asset.description ||
            `${asset.documentCount} 个文件 · ${asset.path}`,
          promptText: `请参考知识库「${asset.name}」（目录：${asset.path}）。`,
        }));
        break;
      default:
        list = [];
    }

    const keyword = parsed.filter.trim().toLowerCase();
    if (!keyword) return list;
    return list.filter(
      (entry) =>
        entry.name.toLowerCase().includes(keyword) ||
        entry.detail.toLowerCase().includes(keyword) ||
        (entry.content?.toLowerCase().includes(keyword) ?? false),
    );
  }, [parsed, fileItems, mcpServers, skills, promptItems, knowledgeBases]);

  const loading =
    parsed.category === "file"
      ? fileLoading
      : parsed.category === "prompt"
        ? promptLoading
        : parsed.category === "tool"
          ? mcpLoading
          : parsed.category === "skill"
            ? skillsLoading
            : parsed.category === "knowledge"
              ? knowledgeLoading
              : false;

  const emptyHint = useMemo(() => {
    if (!parsed.category) return "没有匹配的引用类型";
    if (parsed.filter) {
      return `没有匹配的${CATEGORY_META[parsed.category].label}`;
    }
    switch (parsed.category) {
      case "file":
        return projectId
          ? "工作区中没有可引用的文件"
          : "绑定工作区后，才能引用文件";
      case "tool":
        return "还没有接入 MCP 服务";
      case "skill":
        return "还没有安装可用的技能";
      case "prompt":
        return "提示词库还是空的";
      case "knowledge":
        return "还没有创建知识库";
    }
  }, [parsed, projectId]);

  const headerLabel = parsed.category
    ? [CATEGORY_META[parsed.category].label, parsed.subPath]
        .filter(Boolean)
        .join(" / ")
    : "选择引用类型";

  // ---- items 变化时重置 hover ----
  useEffect(() => {
    setHoverIdx(0);
  }, [entries]);

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
        popupRef.current &&
        !popupRef.current.contains(target) &&
        textareaRef.current &&
        !textareaRef.current.contains(target)
      ) {
        setMentionQuery(null);
        setMentionStart(-1);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [active, textareaRef]);

  const closeMention = useCallback(() => {
    setMentionQuery(null);
    setMentionStart(-1);
  }, []);

  /** 用 replacement 替换当前 `@query`；eatSpace 会顺带吞掉一个连续空格 */
  const replaceMention = useCallback(
    (replacement: string, eatSpace = false) => {
      const ta = textareaRef.current;
      const cursor = ta?.selectionStart ?? input.length;
      if (cursor < mentionStart) {
        closeMention();
        return;
      }
      const before = input.slice(0, mentionStart);
      let after = input.slice(cursor);
      if (eatSpace && after.startsWith(" ")) after = after.slice(1);
      setInput(before + replacement + after);
      pendingCursorRef.current = before.length + replacement.length;
    },
    [input, mentionStart, setInput, textareaRef, closeMention],
  );

  /** 返回上一级：子目录 → 父目录 → 类型层 */
  const goBack = useCallback(() => {
    if (!parsed.category) return;
    let query = "";
    if (parsed.category === "file" && parsed.subPath) {
      const parent = parsed.subPath.split("/").slice(0, -1).join("/");
      query = `file/${parent ? `${parent}/` : ""}`;
    }
    replaceMention(`@${query}`);
    setMentionQuery(query);
  }, [parsed.category, parsed.subPath, replaceMention]);

  // ---- 选择一行 ----
  const selectEntry = useCallback(
    (entry: MentionEntry) => {
      // 类型层：把 `@查` 换成 `@file/` 这类分类前缀，继续在弹窗里选条目
      if (!parsed.category) {
        const query = `${entry.category}/`;
        replaceMention(`@${query}`);
        setMentionQuery(query);
        return;
      }

      // 文件目录：继续下钻
      if (entry.category === "file" && entry.isDirectory) {
        const query = `file/${entry.relativePath}/`;
        replaceMention(`@${query}`);
        setMentionQuery(query);
        return;
      }

      // 提示词：正文直接进输入框，用户可以继续修改
      if (entry.category === "prompt") {
        replaceMention(entry.content ?? "");
        closeMention();
        return;
      }

      // 其余类型：清掉 @query，用标签承载引用
      replaceMention("", true);
      const reference: MentionReference = {
        key: entry.key,
        category: entry.category,
        name: entry.name,
        // 文件在列表里不显示路径（避免每行两段文字），标签上仍用它做 tooltip
        detail: entry.relativePath ?? entry.detail,
        promptText: entry.promptText ?? entry.name,
      };
      setReferences((current) =>
        current.some((item) => item.key === reference.key)
          ? current
          : [...current, reference],
      );
      closeMention();
    },
    [parsed.category, replaceMention, closeMention],
  );

  // ---- textarea onChange：检测 @ mention ----
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const cursor = e.target.selectionStart ?? value.length;
      setInput(value);

      const before = value.slice(0, cursor);
      const match = before.match(/(?:^|\s)@([^\s]*)$/);
      if (match) {
        const query = match[1];
        setMentionStart(cursor - query.length - 1);
        setMentionQuery(query);
      } else {
        closeMention();
      }
    },
    [setInput, closeMention],
  );

  // ---- textarea onKeyDown：导航 / 选择 / 返回 / 关闭 ----
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!active) return false;

      // 查询为空时退格返回上一级（子目录 → 父目录 → 类型层）
      if (e.key === "Backspace" && parsed.category && !parsed.filter) {
        e.preventDefault();
        goBack();
        return true;
      }
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
      if (e.key === "Enter") {
        const entry = entries[hoverIdx];
        if (entry) {
          e.preventDefault();
          selectEntry(entry);
          return true;
        }
        closeMention();
        return false;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const entry = entries[hoverIdx];
        if (entry) selectEntry(entry);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return true;
      }
      return false;
    },
    [active, parsed.category, parsed.filter, entries, hoverIdx, selectEntry, goBack, closeMention],
  );

  const removeReference = useCallback((key: string) => {
    setReferences((current) => current.filter((item) => item.key !== key));
  }, []);

  const clearReferences = useCallback(() => {
    setReferences([]);
  }, []);

  return {
    active,
    entries,
    hoverIdx,
    loading,
    emptyHint,
    headerLabel,
    canBack: parsed.category !== null,
    goBack,
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

/** 条目图标：文件按扩展名，其余按引用类型 */
function EntryIcon({ entry }: { entry: MentionEntry }) {
  if (entry.category === "file") {
    return entry.isDirectory ? (
      <FolderTypeIcon />
    ) : (
      <FileTypeIcon name={entry.name} />
    );
  }
  const Icon = CATEGORY_META[entry.category].icon;
  return <Icon className="h-4 w-4 shrink-0 text-text-muted" />;
}

export function MentionPopup({
  entries,
  hoverIdx,
  loading,
  emptyHint,
  headerLabel,
  canBack,
  onBack,
  onHover,
  onSelect,
  popupRef,
  itemRefs,
}: {
  entries: MentionEntry[];
  hoverIdx: number;
  loading: boolean;
  emptyHint: string;
  headerLabel: string;
  canBack: boolean;
  onBack: () => void;
  onHover: (idx: number) => void;
  onSelect: (entry: MentionEntry) => void;
  popupRef: React.RefObject<HTMLDivElement>;
  itemRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
}) {
  const isCategoryLevel = !canBack;

  return (
    <div
      ref={popupRef}
      className="ui-dropdown-in ui-ring absolute bottom-full left-0 z-50 mb-2 max-h-72 w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl bg-surface p-1.5"
      style={{ boxShadow: "var(--c-shadow)" }}
    >
      {/* 标题栏：类型层显示说明，条目层显示返回 + 分类路径 */}
      <div className="flex items-center gap-1 px-2 pb-1 pt-0.5">
        {canBack && (
          <button
            type="button"
            onClick={onBack}
            title="返回上一级"
            aria-label="返回上一级"
            className="rounded-sm p-0.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate ui-type-sub text-text-muted">
          {headerLabel}
        </span>
        {isCategoryLevel && (
          <span className="shrink-0 ui-type-sub text-text-muted/70">
            ↑↓ 选择
          </span>
        )}
      </div>

      {loading && entries.length === 0 ? (
        <div className="flex items-center gap-2 px-2.5 py-2 ui-type-note text-text-muted">
          <Spinner className="h-3.5 w-3.5" />
          加载中...
        </div>
      ) : entries.length === 0 ? (
        <div className="px-2.5 py-2 ui-type-note text-text-muted">{emptyHint}</div>
      ) : (
        entries.map((entry, i) => (
          <button
            key={entry.key}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(entry)}
            title={entry.detail ? `${entry.name} · ${entry.detail}` : entry.name}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
              i === hoverIdx ? "bg-surface-hover" : ""
            }`}
          >
            <EntryIcon entry={entry} />
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="max-w-[55%] shrink-0 truncate ui-type-body text-text">
                {entry.name}
              </span>
              {entry.detail && (
                <span className="min-w-0 flex-1 truncate ui-type-sub text-text-muted">
                  {entry.detail}
                </span>
              )}
            </span>
            {(isCategoryLevel || entry.isDirectory) && (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            )}
          </button>
        ))
      )}
    </div>
  );
}
