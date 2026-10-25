/**
 * 项目绑定器 — 输入框旁的工作目录选择器
 *
 * 项目不再作为会话的前置层级：新建会话后，用户在这里按需把会话绑定到一个
 * 本地文件夹。绑定后 Agent 在该目录运行，@ 提及与右侧工作区文件树也以它为根。
 *
 * 交互：
 *   - 点击触发器 → 向上展开项目列表（输入框在底部，向下没有空间）
 *   - 选中项目 = 绑定；「不使用项目」= 解绑，回到默认目录
 *   - 「选择本地文件夹…」= 登记新项目并立即绑定
 *   - 已有消息的会话切换目录会重置 Agent 上下文（本地历史仍保留），执行前二次确认
 *   - 项目行 hover 显示删除入口；删除会级联清理该项目下的会话与工作流
 */

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  FolderMinus,
  FolderPlus,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useChatStore } from "../stores/chat";
import { useFileViewerStore } from "../stores/fileViewer";
import { dirName } from "../lib/utils";
import { toast } from "../stores/toast";

const MENU_WIDTH = 288;

/** 项目副标题只保留末尾两级目录，避免长路径把行撑乱 */
function shortPath(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…/${parts.slice(-2).join("/")}`;
}

export function ProjectSelector() {
  const projects = useChatStore((s) => s.projects);
  const currentProjectId = useChatStore((s) => s.currentProjectId);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessions = useChatStore((s) => s.sessions);
  // 当前会话在视图里的消息数：比 sessions 里的 messageCount 更新，
  // 用于判断切换目录是否会影响正在进行的上下文
  const messageCount = useChatStore(
    (s) => s.messagesBySession[s.currentSessionId ?? ""]?.length ?? 0,
  );
  const bindProject = useChatStore((s) => s.bindProject);
  const createProject = useChatStore((s) => s.createProject);
  const deleteProject = useChatStore((s) => s.deleteProject);
  const pickDirectory = useChatStore((s) => s.pickDirectory);
  const openTerminal = useFileViewerStore((s) => s.openTerminal);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const currentProject = projects.find((p) => p.id === currentProjectId);
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const hasContext =
    messageCount > 0 || (currentSession?.messageCount ?? 0) > 0;

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

  /** 绑定 / 切换 / 解绑。已开始的会话换目录前确认上下文重置 */
  const choose = async (projectId: string | null) => {
    setOpen(false);
    if (projectId === currentProjectId) return;

    if (currentSessionId && hasContext) {
      const target = projectId
        ? projects.find((p) => p.id === projectId)?.name ?? "所选项目"
        : "默认目录";
      const confirmed = window.confirm(
        [
          `将当前会话的工作目录切换到「${target}」？`,
          "",
          "会话已经产生消息，切换目录会重置 Agent 的上下文（开启新对话记忆）。",
          "本地历史消息仍会保留，此操作不会删除任何记录。",
        ].join("\n"),
      );
      if (!confirmed) return;
    }

    try {
      await bindProject(projectId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  /** 选择一个本地文件夹：已是项目则直接绑定，否则登记为项目后绑定 */
  const chooseFolder = async () => {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      const cwd = await pickDirectory();
      if (!cwd) return;
      const existing = projects.find((p) => p.cwd === cwd);
      const project = existing ?? (await createProject(dirName(cwd), cwd));
      if (!project) throw new Error("创建项目失败");
      await choose(project.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (id: string, name: string) => {
    const confirmed = window.confirm(
      [
        `删除项目「${name}」？`,
        "",
        "将同时删除：",
        "· 该项目下的所有会话",
        "· 该项目下的工作流与运行记录",
        "· 项目目录下的 .novastudio 产物",
        "",
        "项目文件夹本身不会被删除。此操作不可恢复。",
      ].join("\n"),
    );
    if (!confirmed) return;
    setOpen(false);
    try {
      await deleteProject(id);
      toast.success(`项目「${name}」已删除`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      {/* 触发器：绑定后显示项目名，未绑定显示引导文案 */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={
          currentProject
            ? `工作目录：${currentProject.cwd}`
            : "为本次会话绑定一个项目目录（可选）"
        }
        aria-haspopup="menu"
        aria-expanded={open}
        className={`ui-ring flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-input-bg px-3 text-meta text-text-secondary outline-none transition-all hover:border-input-border-focus hover:text-text ${
          open ? "border-input-border-focus text-text" : ""
        }`}
      >
        <Folder
          className={`h-3.5 w-3.5 shrink-0 ${
            currentProject ? "text-accent" : "text-text-muted"
          }`}
        />
        <span className="max-w-[120px] truncate font-medium">
          {currentProject?.name ?? "绑定项目"}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* 下拉面板：向上展开 */}
      {open && (
        <div
          role="menu"
          className="ui-dropdown-in ui-glass-strong ui-ring absolute bottom-full right-0 z-50 mb-2 rounded-xl p-1.5"
          style={{ width: MENU_WIDTH, boxShadow: "var(--c-shadow)" }}
        >
          <div className="px-2.5 pb-1 pt-1">
            <div className="text-caption font-medium text-text-muted">工作目录</div>
            <div className="mt-0.5 text-caption leading-relaxed text-text-muted/80">
              Agent 在此目录运行，@ 提及与文件树都以它为根
            </div>
          </div>

          <div className="ui-scroll-hidden max-h-64 overflow-y-auto">
            {currentProject && (
              <button
                type="button"
                onClick={() => void choose(null)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
              >
                <span className="flex size-avatar shrink-0 items-center justify-center rounded-md bg-surface-hover text-text-muted">
                  <FolderMinus className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium">
                    不使用项目
                  </span>
                  <span className="block truncate text-caption text-text-muted">
                    在默认目录中运行
                  </span>
                </span>
              </button>
            )}

            {projects.length === 0 ? (
              <div className="px-3 py-3 text-meta leading-relaxed text-text-muted">
                还没有项目。选择一个本地文件夹，即可把会话绑定到该工作目录。
              </div>
            ) : (
              projects.map((project) => {
                const active = project.id === currentProjectId;
                return (
                  <div
                    key={project.id}
                    role="menuitem"
                    tabIndex={0}
                    onClick={() => void choose(project.id)}
                    onKeyDown={(e) => {
                      // 忽略来自内部删除按钮的冒泡，避免误触绑定
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void choose(project.id);
                      }
                    }}
                    title={project.cwd}
                    className={`group/proj flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      active
                        ? "bg-surface-active text-text"
                        : "text-text-secondary hover:bg-surface-hover hover:text-text"
                    }`}
                  >
                    <span
                      className={`flex size-avatar shrink-0 items-center justify-center rounded-md ${
                        active
                          ? "bg-accent-soft text-accent"
                          : "bg-surface-hover text-text-muted"
                      }`}
                    >
                      <Folder className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-medium">
                        {project.name}
                      </span>
                      <span className="block truncate font-mono text-caption text-text-muted">
                        {shortPath(project.cwd)}
                      </span>
                    </span>
                    {active && (
                      <Check className="h-4 w-4 shrink-0 text-accent" />
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        openTerminal(project.cwd, `${project.name} · 终端`);
                      }}
                      title="在此项目中打开终端"
                      className="shrink-0 rounded-md p-1 text-text-muted opacity-0 transition-all hover:bg-surface-active hover:text-text group-hover/proj:opacity-100"
                    >
                      <SquareTerminal className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeProject(project.id, project.name);
                      }}
                      title="删除项目"
                      className="shrink-0 rounded-md p-1 text-text-muted opacity-0 transition-all hover:bg-error-bg hover:text-error group-hover/proj:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="my-1 h-px bg-border" />

          <button
            type="button"
            disabled={busy}
            onClick={() => void chooseFolder()}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-body text-text-secondary transition-colors hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="flex size-avatar shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
              <FolderPlus className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {busy ? "正在选择…" : "选择本地文件夹…"}
              </span>
              <span className="block truncate text-caption text-text-muted">
                登记为新项目并立即绑定
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
