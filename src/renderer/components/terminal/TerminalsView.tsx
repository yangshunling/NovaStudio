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
import { MENU_WIDTH, MenuItem, MenuPanel } from "../ui/Menu";
import {
  Folder,
  FolderKanban,
  FolderOpen,
  SquareTerminal,
  X,
} from "lucide-react";
import { useChatStore } from "../../stores/chat";
import { useTerminalStore } from "../../stores/terminal";
import { ipc } from "../../lib/ipc";
import type { FileTab } from "../../stores/fileViewer";
import { NoWorkspaceState } from "../ui/NoWorkspaceState";
import { ListItem, ListPane } from "../ui/ListPane";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Page, PageHeader } from "../ui/Page";
import { TerminalView, WorkspaceToggleButton } from "./TerminalView";
import { WorkspacePanel } from "../workspaces/WorkspacePanel";
import { FilePreview } from "../files/FilePreview";
import type { Project } from "@shared/types";

/** 右键菜单尺寸：用于贴近视口边缘时收拢位置 */
const MENU_HEIGHT = 128;

export function TerminalsView() {
  const projects = useChatStore((s) => s.projects);
  const setViewMode = useChatStore((s) => s.setViewMode);
  const terminals = useTerminalStore((s) => s.terminals);
  const activeId = useTerminalStore((s) => s.activeId);
  const openTerminal = useTerminalStore((s) => s.open);
  const closeTerminal = useTerminalStore((s) => s.close);
  const requestedWorkspaceId = useTerminalStore(
    (s) => s.requestedWorkspaceId,
  );
  const clearRequestedWorkspace = useTerminalStore(
    (s) => s.clearRequestedWorkspace,
  );
  /** 右侧文件面板里点开的文件：终端上方内嵌预览，关闭后回到终端 */
  const [preview, setPreview] = useState<FileTab | null>(null);
  /** 右侧工作区文件面板是否展开；默认收起，由顶栏按钮手动打开 */
  const [showWorkspace, setShowWorkspace] = useState(false);
  /** 工作区右键菜单：同一时间只开一个 */
  const [menu, setMenu] = useState<{
    project: Project;
    x: number;
    y: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /**
   * 左栏当前选中的工作区。
   *
   * 不能从 activeTerminal 反推：关闭终端时 activeId 会落到别的工作区，
   * 反推会让左栏选中项莫名跳走，看起来像关错了终端。这里只在用户
   * 主动点击工作区时改变，关闭终端不影响当前选中项。
   */
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );

  const activeTerminal =
    terminals.find((tab) => tab.id === activeId) ?? terminals[0] ?? null;
  const selectedWorkspace =
    projects.find((project) => project.id === selectedWorkspaceId) ??
    projects.find((project) => project.id === activeTerminal?.workspaceId) ??
    projects[0] ??
    null;
  const visibleTerminal = selectedWorkspace
    ? (terminals.find((tab) => tab.workspaceId === selectedWorkspace.id) ?? null)
    : null;

  /** 点击工作区：定位到该目录打开终端；已有终端则直接切回 */
  const openInWorkspace = (project: Project) => {
    setSelectedWorkspaceId(project.id);
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

  /**
   * 其他页面（工作区卡片 / 详情）打开终端时，可能不是当前选中的工作区。
   * 这里消费一次性请求，切换到对应工作区；关闭终端不会触发这个逻辑。
   */
  useEffect(() => {
    if (!requestedWorkspaceId) return;
    setSelectedWorkspaceId(requestedWorkspaceId);
    clearRequestedWorkspace();
  }, [requestedWorkspaceId, clearRequestedWorkspace]);

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
      <Page className="min-w-0">
        <NoWorkspaceState
          description="工作区是一个根目录。终端会定位到该目录运行。工作区统一在「工作区」页面登记，这里直接选用即可。"
          onManage={() => setViewMode("workspaces")}
        />
      </Page>
    );
  }

  return (
    <Page className="min-w-0">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左：工作区列表（与工作流页一致） */}
        <ListPane
          title="工作区"
          count={projects.length}
          action={
            <button
              type="button"
              onClick={() => setViewMode("workspaces")}
              title="管理工作区"
              aria-label="管理工作区"
              className="ui-btn-round ui-icon-action flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors active:scale-95"
            >
              <FolderKanban className="h-4 w-4" />
            </button>
          }
          footer={
            <p className="px-1.5 py-0.5 text-caption leading-relaxed text-text-muted">
              点击工作区即可在该目录打开终端
            </p>
          }
        >
          {projects.map((project) => {
            const isActive = project.id === selectedWorkspace?.id;
            const terminal =
              terminals.find((tab) => tab.workspaceId === project.id) ?? null;

            return (
              <ListItem
                key={project.id}
                active={isActive}
                icon={
                  terminal ? (
                    <SquareTerminal className="h-4 w-4" />
                  ) : (
                    <Folder className="h-4 w-4" />
                  )
                }
                title={project.name}
                subtitle={project.cwd}
                monoSubtitle
                titleAttr={
                  terminal
                    ? `切换到「${project.name}」的终端（右键可关闭）`
                    : `在「${project.name}」打开终端（右键可关闭）`
                }
                onClick={() => openInWorkspace(project)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ project, ...menuPosition(event) });
                }}
                trailing={
                  terminal ? (
                    <span
                      title="已打开"
                      className="h-2 w-2 shrink-0 rounded-full bg-success"
                    />
                  ) : undefined
                }
              />
            );
          })}
        </ListPane>

        {/* 中：当前工作区的终端；其他终端保持挂载，切换不会重启进程 */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {visibleTerminal ? (
            terminals.map((tab) => (
              <div
                key={tab.id}
                className={tab.id === visibleTerminal.id ? "h-full" : "hidden"}
              >
                <TerminalView
                  tab={tab}
                  showWorkspace={showWorkspace}
                  onToggleWorkspace={() => setShowWorkspace((open) => !open)}
                />
              </div>
            ))
          ) : selectedWorkspace ? (
            <main className="flex h-full min-h-0 flex-col overflow-hidden">
              {/* 尚未打开终端时也保留同一条顶栏，工作区文件面板的开关不会消失 */}
              <PageHeader
                icon={<SquareTerminal className="h-4 w-4" />}
                title={selectedWorkspace.name}
                subtitle={selectedWorkspace.cwd}
                actions={
                  <WorkspaceToggleButton
                    showWorkspace={showWorkspace}
                    onToggle={() => setShowWorkspace((open) => !open)}
                  />
                }
              />
              <div className="min-h-0 flex-1">
                <WorkspacePrompt
                  project={selectedWorkspace}
                  onOpen={() => openInWorkspace(selectedWorkspace)}
                />
              </div>
            </main>
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

        {/* 右：与会话页一致的工作区文件面板，顶栏按钮控制显隐 */}
        {showWorkspace && (
          <WorkspacePanel
            project={selectedWorkspace}
            onOpenFile={openPreview}
            activeFileId={preview?.id ?? null}
          />
        )}
      </div>

      {/* 工作区右键菜单：关闭终端等低频操作不占列表空间 */}
      {menu && (
        <MenuPanel x={menu.x} y={menu.y} menuRef={menuRef}>
          <MenuItem
            icon={SquareTerminal}
            label={menuTerminal ? "切换到终端" : "打开终端"}
            onClick={() => {
              openInWorkspace(menu.project);
              setMenu(null);
            }}
          />
          <MenuItem
            icon={FolderOpen}
            label="打开工作区"
            onClick={() => {
              void ipc.revealProject(menu.project.id);
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
                setSelectedWorkspaceId(menu.project.id);
                setMenu(null);
              }}
            />
          )}
        </MenuPanel>
      )}
    </Page>
  );
}

/** 右键菜单项 */
/** 选中工作区但还没有终端时的引导 */
function WorkspacePrompt({
  project,
  onOpen,
}: {
  project: Project;
  onOpen: () => void;
}) {
  return (
    <div className="mx-auto flex h-full max-w-md items-center justify-center">
      <EmptyState
        icon={<SquareTerminal />}
        title={`「${project.name}」还没有打开终端`}
        description="打开后会直接定位到该工作区目录。"
        action={
          <Button
            variant="primary"
            size="sm"
            icon={<SquareTerminal className="h-4 w-4" />}
            onClick={onOpen}
          >
            打开终端
          </Button>
        }
      />
    </div>
  );
}
