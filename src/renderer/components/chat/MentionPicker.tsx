/**
 * 输入框快捷引用 —— 三个触发字符各管一件事
 *
 *   @  引用数字员工（谁来回这一轮）
 *   #  引用内容（文件 / 工具 / 技能 / 提示词 / 知识库，仍是分类 → 条目两层）
 *
 * 为什么把员工单独拆出来：@ 员工是高频动作，而内容和员工的选中语义完全不同
 * —— 内容是一段要发给 Agent 的引用，员工是「下一条消息由谁回答」的选择。
 * 混在一个弹窗里，选员工要先在类型层里翻一层；拆开后 `@需` + Enter 就能切换。
 *
 * 交互：
 *   1. 行首 / 空格 / 非单词字符后输入 @ 或 # → 弹出对应列表
 *   2. @：只列已启用的员工，选中即绑定（与输入框旁「指定员工」同一处状态）
 *   3. #：先选引用类型，再选条目；文件类型保留目录下钻
 *   4. ↑↓ 导航，Enter 确认；Backspace 在空查询时返回上一级
 *   5. Tab 强制选择、Esc / 外部点击关闭
 *
 * 内容的选择结果：
 *   - 文件 / 工具 / 技能 / 知识库 → 作为引用标签挂在输入框上方，发送时转成提示词
 *   - 提示词 → 正文直接插入输入框，由用户确认后发送
 *
 * 文件列表通过 IPC 从主进程读取（带缓存）；工具 / 技能 / 知识库复用
 * assets store 的扫描结果；数字员工复用 employees store，与输入框旁的
 * 「指定员工」读写同一份会话绑定；提示词每次进入分类时重新读取，
 * 保证刚改过就能看到。
 */

import { useState, useEffect, useRef, useMemo, useCallback, } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Library,
  MessageSquareText,
  Sparkles,
  UserRound,
  Wrench,
} from "lucide-react";
import {
  useKnowledgeBasesStore,
  useMcpServersStore,
  useSkillsStore,
} from "../../stores/assets";
import { useEmployeesStore } from "../../stores/employees";
import {
  chooseEmployee,
  DEFAULT_ASSISTANT,
} from "../../lib/employee-switch";
import { ipc } from "../../lib/ipc";
import type { FileEntry, PromptItem } from "@shared/types";
import { EmployeeAvatar } from "../employees/EmployeeAvatar";
import claudeAvatarUrl from "../../assets/claude.png";
import { FileTypeIcon } from "../ui/FileTypeIcon";
import { FolderTypeIcon } from "../ui/FolderTypeIcon";
import { Spinner } from "../ui/Spinner";

// ============================================================================
// 类型与常量
// ============================================================================

export type MentionCategory =
  | "file"
  | "employee"
  | "tool"
  | "skill"
  | "prompt"
  | "knowledge";

/** 触发字符：@ 选员工，# 引用内容 */
export type MentionTrigger = "@" | "#";

/**
 * 发送时会转成提示词的引用（提示词正文直接插入，不走标签）。
 *
 * 数字员工不在其中：它不是一段提示词，而是本次会话的执行者，
 * 选中后直接写进会话绑定，与输入框旁的「指定员工」行为一致。
 */
export interface MentionReference {
  key: string;
  category: "file" | "tool" | "skill" | "knowledge";
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
  /** 数字员工：绑定到当前会话的员工 id；null 表示解除绑定 */
  employeeId?: string | null;
  /** 数字员工：头像 data URL，列表里优先展示头像 */
  avatar?: string | null;
}

const CATEGORY_META: Record<
  MentionCategory,
  { label: string; description: string; icon: LucideIcon }
> = {
  file: { label: "文件", description: "工作区中的文件与目录", icon: FileText },
  employee: {
    label: "数字员工",
    description: "指定本次会话由谁执行",
    icon: UserRound,
  },
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

/**
 * `#` 内容引用的类型顺序。
 * 数字员工不在这里：它由 `@` 单独承载。
 */
const CONTENT_CATEGORIES: readonly MentionCategory[] = [
  "file",
  "tool",
  "skill",
  "prompt",
  "knowledge",
];

function isContentCategory(value: string): value is MentionCategory {
  return CONTENT_CATEGORIES.some((key) => key === value);
}

/** 提示词正文压成单行摘要，避免长文把列表行撑开 */
function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

// ============================================================================
// Trigger 解析
// ============================================================================

interface TriggerMatch {
  trigger: MentionTrigger;
  /** 触发字符之后的查询串 */
  query: string;
  /** 触发字符所在下标 */
  start: number;
}

/**
 * 从光标前的文本里找最近的触发字符。
 *
 * `@` 前面不能是邮箱本地部分（`a@b.com` 不触发）；`#` 前面不能是单词
 * 字符（`C#` 不触发）。两者都以「非单词字符」作为边界，因此中文正文里
 * 直接写 `请@需求开发` 也能触发。
 *
 * 同一时刻可能两个都能命中（如 `@#`），取最左边那个：右边的 `#`
 * 属于 `@` 的查询串，不该另起一个弹窗。
 */
function findTrigger(before: string): TriggerMatch | null {
  const candidates: TriggerMatch[] = [];

  const at = before.match(/(?:^|[^A-Za-z0-9._%+\-@])@([^\s]*)$/);
  if (at) {
    const query = at[1];
    candidates.push({
      trigger: "@",
      query,
      start: before.length - query.length - 1,
    });
  }

  // 排除 `/`：链接里的 `#锚点`（`https://x.dev/#a`）不是引用意图
  const hash = before.match(/(?:^|[^A-Za-z0-9._%+\-/])#([^\s]*)$/);
  if (hash) {
    const query = hash[1];
    candidates.push({
      trigger: "#",
      query,
      start: before.length - query.length - 1,
    });
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((left, item) => (item.start < left.start ? item : left));
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
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
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
  // 数字员工与输入框旁的「指定员工」共用同一份列表与会话绑定
  const employees = useEmployeesStore((s) => s.employees);
  const employeesLoading = useEmployeesStore((s) => s.loading);
  const loadEmployees = useEmployeesStore((s) => s.load);

  const active = mentionQuery !== null;
  /** `@` 打开的是员工列表；结构上等价于「已经选完分类」，但没有返回上一级 */
  const employeeMode = trigger === "@";

  // ---- 解析 query：`file/src/` → 分类 file、子目录 src ----
  const parsed = useMemo(() => {
    if (mentionQuery === null || employeeMode) {
      return {
        category: null as MentionCategory | null,
        filter: mentionQuery ?? "",
        subPath: "",
      };
    }
    const slash = mentionQuery.indexOf("/");
    if (slash < 0) {
      return { category: null as MentionCategory | null, filter: mentionQuery, subPath: "" };
    }
    const key = mentionQuery.slice(0, slash);
    if (!isContentCategory(key)) {
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
  }, [mentionQuery, employeeMode]);

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

  // ---- 数字员工 / 工具 / 技能 / 知识库：进入分类时确保已加载 ----
  useEffect(() => {
    if (!active) return;
    if (employeeMode) {
      void loadEmployees();
      return;
    }
    if (parsed.category === "tool") void loadMcp();
    else if (parsed.category === "skill") void loadSkills();
    else if (parsed.category === "knowledge") void loadKnowledge();
  }, [active, employeeMode, parsed.category, loadEmployees, loadMcp, loadSkills, loadKnowledge]);

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
    setTrigger(null);
    setFileItems([]);
    setReferences([]);
  }, [projectId]);

  // ---- 切换会话时清空引用，避免旧引用跟着草稿混进另一个上下文 ----
  useEffect(() => {
    setReferences([]);
    setMentionQuery(null);
    setMentionStart(-1);
    setTrigger(null);
    setFileItems([]);
    loadedSubPathRef.current = null;
    setHoverIdx(0);
  }, [draftKey]);

  // ---- 组装当前层的候选行 ----
  const entries = useMemo<MentionEntry[]>(() => {
    const keyword = parsed.filter.trim().toLowerCase();
    const hit = (...texts: (string | undefined)[]) =>
      !keyword || texts.some((text) => (text ?? "").toLowerCase().includes(keyword));

    /*
     * @ 员工：只列已启用的员工。
     * 「通用助手」默认项始终保留、且排在最后：没有数字员工时它仍然可用，
     * 放在末尾又能避免 `@` + Enter 误解除当前绑定。
     */
    if (employeeMode) {
      const list: MentionEntry[] = employees
        .filter((employee) => employee.enabled)
        .filter((employee) => hit(employee.name, employee.role))
        .map((employee) => ({
          key: `employee:${employee.id}`,
          category: "employee",
          name: employee.name,
          detail: employee.role || "数字员工",
          employeeId: employee.id,
          avatar: employee.avatar,
        }));
      // 默认项：不绑定员工，由 Agent 全局配置（通用助手）作答
      if (hit(DEFAULT_ASSISTANT.name, "助手", "默认", "default")) {
        list.push({
          key: "employee:default",
          category: "employee",
          name: DEFAULT_ASSISTANT.name,
          detail: DEFAULT_ASSISTANT.detail,
          employeeId: null,
        });
      }
      return list;
    }

    // 类型层
    if (!parsed.category) {
      return CONTENT_CATEGORIES.filter((key) => {
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

    if (!keyword) return list;
    return list.filter(
      (entry) =>
        entry.name.toLowerCase().includes(keyword) ||
        entry.detail.toLowerCase().includes(keyword) ||
        (entry.content?.toLowerCase().includes(keyword) ?? false),
    );
  }, [
    parsed,
    employeeMode,
    fileItems,
    employees,
    mcpServers,
    skills,
    promptItems,
    knowledgeBases,
  ]);

  const loading = employeeMode
    ? employeesLoading
    : parsed.category === "file"
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
    if (employeeMode) {
      return keywordHint(parsed.filter)
        ? "没有匹配的数字员工"
        : "没有已启用的数字员工，请先在「数字员工」页面启用";
    }
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
      case "employee":
        return "没有已启用的数字员工，请先在「数字员工」页面启用";
    }
  }, [employeeMode, parsed, projectId]);

  const headerLabel = employeeMode
    ? "选择回答者"
    : parsed.category
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

  const closeMention = useCallback(() => {
    setMentionQuery(null);
    setMentionStart(-1);
    setTrigger(null);
  }, []);

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
        closeMention();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [active, textareaRef, closeMention]);

  /** 用 replacement 替换当前 `[trigger]query`；eatSpace 会顺带吞掉一个连续空格 */
  const replaceMention = useCallback(
    (replacement: string, eatSpace = false) => {
      const ta = textareaRef.current;
      const cursor = ta?.selectionStart ?? input.length;
      // mentionStart 无效时绝不能走 slice(0, -1)，那会误删正文最后一个字符
      if (mentionStart < 0 || cursor < mentionStart) {
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

  /**
   * 把弹窗里的查询写回正文。
   * 触发字符要保留：`#` 不能丢，否则下一次 change 就解析不回分类了。
   */
  const writeQuery = useCallback(
    (query: string) => {
      replaceMention(`${trigger ?? ""}${query}`);
      setMentionQuery(query);
    },
    [replaceMention, trigger],
  );

  /** 返回上一级：子目录 → 父目录 → 类型层 */
  const goBack = useCallback(() => {
    if (employeeMode || !parsed.category) return;
    let query = "";
    if (parsed.category === "file" && parsed.subPath) {
      const parent = parsed.subPath.split("/").slice(0, -1).join("/");
      query = `file/${parent ? `${parent}/` : ""}`;
    }
    writeQuery(query);
  }, [employeeMode, parsed.category, parsed.subPath, writeQuery]);

  // ---- 选择一行 ----
  const selectEntry = useCallback(
    (entry: MentionEntry) => {
      /*
       * 数字员工：不生成引用标签，直接写进当前会话的员工绑定，
       * 与输入框旁「指定员工」的选择结果是同一处状态。
       * `@` 只是入口，不进入正文，所以整段 `@查询` 一并清掉。
       */
      if (entry.category === "employee") {
        replaceMention("", true);
        // 运行中也可以切换（下一轮生效），提示文案由 chooseEmployee 统一给出
        chooseEmployee(entry.employeeId ?? null);
        closeMention();
        return;
      }

      // 类型层：把 `/查` 换成 `/file/` 这类分类前缀，继续在弹窗里选条目
      if (!parsed.category) {
        writeQuery(`${entry.category}/`);
        return;
      }

      // 文件目录：继续下钻
      if (entry.category === "file" && entry.isDirectory) {
        writeQuery(`file/${entry.relativePath}/`);
        return;
      }

      // 提示词：正文直接进输入框，用户可以继续修改
      if (entry.category === "prompt") {
        replaceMention(entry.content ?? "");
        closeMention();
        return;
      }

      // 其余类型：清掉查询，用标签承载引用
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
    [parsed.category, replaceMention, writeQuery, closeMention],
  );

  // ---- textarea onChange：检测 @ / 触发 ----
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const cursor = e.target.selectionStart ?? value.length;
      setInput(value);

      const found = findTrigger(value.slice(0, cursor));
      if (!found) {
        closeMention();
        return;
      }

      /*
       * 查询里带 `/` 时只认已知分类前缀（`#file/src`），
       * 其余情况按普通正文处理，避免把用户随手写的路径吞进弹窗。
       */
      if (found.trigger === "#" && found.query) {
        const slash = found.query.indexOf("/");
        if (slash >= 0 && !isContentCategory(found.query.slice(0, slash))) {
          closeMention();
          return;
        }
      }

      setTrigger(found.trigger);
      setMentionStart(found.start);
      setMentionQuery(found.query);
    },
    [setInput, closeMention],
  );

  // ---- textarea onKeyDown：导航 / 选择 / 返回 / 关闭 ----
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      // 输入法组合期间的 Enter / 方向键属于候选词选择，不能被弹窗消费
      if (e.nativeEvent.isComposing || e.keyCode === 229) return false;
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

  /**
   * 还原引用快照。
   *
   * 发送前置失败（会话创建失败、Agent 未安装）时消息并没有真正发出，
   * 已清空的引用标签必须还回去，否则用户要重新挑一遍文件 / 技能 / 知识库。
   */
  const restoreReferences = useCallback((snapshot: MentionReference[]) => {
    setReferences(snapshot);
  }, []);

  return {
    active,
    /** 弹窗层级：类型层 / 条目层（员工列表按条目层渲染，但没有返回） */
    kind: employeeMode || parsed.category ? ("entries" as const) : ("category" as const),
    entries,
    hoverIdx,
    loading,
    emptyHint,
    headerLabel,
    canBack: !employeeMode && parsed.category !== null,
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
    restoreReferences,
  };
}

/** filter 是否非空（用于区分「没搜到」和「本来就没有」） */
function keywordHint(filter: string): boolean {
  return filter.trim().length > 0;
}

// ============================================================================
// Popup
// ============================================================================

/** 条目图标：文件按扩展名，其余按引用类型 */
function EntryIcon({ entry }: { entry: MentionEntry }) {
  if (entry.category === "employee") {
    // 默认项（不绑定员工）用 Claude 头像，与消息区左侧保持一致
    if (!entry.employeeId) {
      return (
        <img
          src={claudeAvatarUrl}
          alt={DEFAULT_ASSISTANT.name}
          width={16}
          height={16}
          draggable={false}
          className="h-4 w-4 shrink-0 rounded-full object-cover"
        />
      );
    }
    return (
      <EmployeeAvatar
        employee={{ name: entry.name, avatar: entry.avatar ?? null }}
        size={16}
      />
    );
  }
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
  kind,
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
  /** category = 类型层（行可进入下一级）；entries = 条目层 */
  kind: "category" | "entries";
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
  const isCategoryLevel = kind === "category";

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
        <span className="shrink-0 ui-type-sub text-text-muted/70">
          ↑↓ 选择
        </span>
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
              <span
                className={`truncate ui-type-body text-text ${
                  entry.detail ? "max-w-[55%] shrink-0" : "min-w-0 flex-1"
                }`}
              >
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
