/**
 * 终端管理页
 *
 * 与工作流页同一套结构：左侧直接列出全部工作区，右侧展示当前工作区的终端。
 *
 * - 点击工作区：已有终端则切回，没有则在该目录创建一个普通终端；
 * - 每个工作区最多一个终端；所有 xterm 实例保持挂载，切换不会重启 PTY；
 * - 最右侧复用会话页的工作区文件面板，点击文件在终端上内嵌预览；
 * - 本组件由 App 常驻挂载（非激活时隐藏），切到其他侧栏页面再回来，
 *   终端进程、输出与文件面板展开状态都还在。
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Folder,
  FolderKanban,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { useChatStore } from "../../stores/chat";
import { useTerminalStore } from "../../stores/terminal";
import type { FileTab } from "../../stores/fileViewer";
import { NoWorkspaceState } from "../ui/NoWorkspaceState";
import { TerminalView } from "../TerminalView";
import { WorkspacePanel } from "../WorkspacePanel";
import { FilePreview } from "../FilePreview";
import type { Project } from "@shared/types";

/** 右键菜单尺寸：用于贴近视口边缘时收拢位置 */
const MENU_WIDTH = 192;
const MENU_HEIGHT = 88;

export function TerminalsView() {
  const projects = useChatStore((s) => s.projects);
  const setViewMode = useChatStore((s) => s.setViewMode);
  const terminals = useTerminalStore((s) => s.terminals);
  const activeId = useTerminalStore((s) => s.activeId);
  const openTerminal = useTerminalStore((s) => s.open);
  const closeTerminal = useTerminalStore((s) => s.close);
  /** 右侧文件面板里点开的文件：终端上方内嵌预览，关闭后回到终端 */
  const [preview, setPreview] = useState<FileTab | null>(null);
  /** 工作区右键菜单：同一时间只开一个 */
  const [menu, setMenu] = useState<{
    project: Project;
    x: number;
    y: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 当前终端所属的工作区；没有打开任何终端时默认落到第一个工作区
  const activeTerminal =
    terminals.find((tab) => tab.id === activeId) ?? terminals[0] ?? null;
  const selectedWorkspace =
    projects.find((project) => project.id === activeTerminal?.workspaceId) ??
    projects[0] ??
    null;
  const visibleTerminal = selectedWorkspace
    ? (terminals.find((tab) => tab.workspaceId === selectedWorkspace.id) ?? null)
    : null;

  /** 点击工作区：定位到该目录打开终端；已有终端则直接切回 */
  const openInWorkspace = (project: Project) => {
    openTerminal({
      workspaceId: project.id,
      cwd: project.cwd,
      name: project.name,
    });
  };

  /** 切到别的工作区时收起预览，避免预览内容与当前文件树对不上 */
  useEffect(() => {
    setPreview(null);
  }, [selectedWorkspace?.id]);

  // 右键菜单：外部点击 / Esc / 滚动 / 窗口缩放时关闭
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  /** 把菜单坐标收拢在视口内 */
  const menuPosition = (event: React.MouseEvent) => ({
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - 8)),
  });

  const menuTerminal = menu
    ? (terminals.find((tab) => tab.workspaceId === menu.project.id) ?? null)
    : null;

  const openPreview = (file: {
    projectId: string;
    relativePath: string;
    name: string;
  }) => {
    setPreview({
      kind: "file",
      id: `${file.projectId}:${file.relativePath}`,
      ...file,
    });
  };

  // 还没有工作区时与工作流页保持一致：整页展示同一个空态
  if (projects.length === 0) {
    return (
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden">
          <NoWorkspaceState
            description="工作区是一个根目录。终端会定位到该目录运行。工作区统一在「工作区」页面登记，这里直接选用即可。"
            onManage={() => setViewMode("workspaces")}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="ui-page relative z-10 flex min-h-0 flex-1 overflow-hidden">
        {/* 左：工作区列表（与工作流页一致） */}
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-[var(--c-panel-bg)] shadow-[var(--c-shadow-sm)]">
          <div className="flex h-[var(--c-layout-header)] shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-meta font-semibold tracking-wide text-text-muted">
                工作区
              </p>
              <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 font-mono text-caption text-text-muted">
                {projects.length}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setViewMode("workspaces")}
              title="管理工作区"
              className="ui-btn-round ui-icon-action flex h-8 w-8 items-center justify-center rounded-full text-text-muted transition-colors active:scale-95"
            >
              <FolderKanban className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-4 pt-4">
            {projects.map((project) => {
              const isActive = project.id === selectedWorkspace?.id;
              const terminal =
                terminals.find((tab) => tab.workspaceId === project.id) ?? null;

              return (
                <div
                  key={project.id}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ project, ...menuPosition(event) });
                  }}
                  className={`flex w-full items-center rounded-xl transition-colors ${
                    isActive
                      ? "bg-surface-active text-text shadow-[var(--c-shadow-sm)]"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => openInWorkspace(project)}
                    title={
                      terminal
                        ? `切换到「${project.name}」的终端（右键可关闭）`
                        : `在「${project.name}」打开终端（右键可关闭）`
                    }
                    className="flex min-w-0 flex-1 items-center gap-3 px-2.5 py-2.5 text-left"
                  >
                    <span
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
                        isActive
                          ? "bg-accent-soft text-accent"
                          : "bg-surface-hover text-text-muted"
                      }`}
                    >
                      {terminal ? (
                        <SquareTerminal className="h-4 w-4" />
                      ) : (
                        <Folder className="h-4 w-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-lg font-medium">
                        {project.name}
                      </span>
                      <span className="block truncate font-mono text-caption text-text-muted">
                        {project.cwd}
                      </span>
                    </span>
                    {terminal && (
                      <span
                        title="已打开"
                        className="h-2 w-2 shrink-0 rounded-full bg-success"
                      />
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="border-t border-border px-4 py-3 text-caption leading-relaxed text-text-muted">
            点击工作区即可在该目录打开终端
          </div>
        </aside>

        {/* 中：当前工作区的终端；其他终端保持挂载，切换不会重启进程 */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {visibleTerminal ? (
            terminals.map((tab) => (
              <div
                key={tab.id}
                className={tab.id === visibleTerminal.id ? "h-full" : "hidden"}
              >
                <TerminalView tab={tab} />
              </div>
            ))
          ) : selectedWorkspace ? (
            <WorkspacePrompt
              project={selectedWorkspace}
              onOpen={() => openInWorkspace(selectedWorkspace)}
            />
          ) : null}

          {/* 文件预览覆盖在终端之上：终端进程仍在后台继续运行 */}
          {preview && (
            <div className="absolute inset-0 z-20 bg-bg">
              <FilePreview
                tab={preview}
                embedded
                onClose={() => setPreview(null)}
              />
            </div>
          )}
        </div>

        {/* 右：与会话页一致的工作区文件面板 */}
        <WorkspacePanel
          project={selectedWorkspace}
          onOpenFile={openPreview}
          activeFileId={preview?.id ?? null}
        />
      </div>

      {/* 工作区右键菜单：关闭终端等低频操作不占列表空间 */}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: menu.y, left: menu.x, width: MENU_WIDTH }}
            className="ui-dropdown-in ui-glass-strong ui-ring fixed z-[60] rounded-xl p-1.5"
          >
            <MenuItem
              icon={SquareTerminal}
              label={menuTerminal ? "切换到终端" : "打开终端"}
              onClick={() => {
                openInWorkspace(menu.project);
                setMenu(null);
              }}
            />
            {menuTerminal && (
              <MenuItem
                icon={X}
                label="关闭终端"
                danger
                onClick={() => {
                  closeTerminal(menuTerminal.id);
                  setMenu(null);
                }}
              />
            )}
          </div>,
          document.body,
        )}
    </main>
  );
}

/** 右键菜单项 */
function MenuItem({
  icon: Icon,
  label,
  danger = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-meta transition-colors ${
        danger
          ? "text-error hover:bg-error-bg"
          : "text-text-secondary hover:bg-surface-hover hover:text-text"
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  );
}

/** 选中工作区但还没有终端时的引导 */
function WorkspacePrompt({
  project,
  onOpen,
}: {
  project: Project;
  onOpen: () => void;
}) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center text-text-muted">
      <div className="ui-btn-round flex h-16 w-16 items-center justify-center rounded-2xl">
        <SquareTerminal className="h-6 w-6" />
      </div>
      <h2 className="ui-serif text-heading font-semibold text-text-secondary">
        「{project.name}」还没有打开终端
      </h2>
      <p className="text-body leading-relaxed">
        打开后会直接定位到该工作区目录。
      </p>
      <button
        type="button"
        onClick={onOpen}
        className="ui-btn-primary mt-2 flex h-9 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95"
      >
        <SquareTerminal className="h-4 w-4" />
        打开终端
      </button>
    </div>
  );
}
