/**
 * 工作区工作台
 *
 * 左侧工作区列表 + 右侧控制台（文件 / Git）。
 * 不做内容统计概览：页面只回答「这个目录里有哪些文件」和「Git 现在什么状态」。
 */

import { useEffect, useState } from "react";
import { ChevronRight, Folder, FolderKanban, FolderPlus } from "lucide-react";
import type { Project } from "@shared/types";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { useChatStore } from "../../stores/chat";
import { useFileViewerStore } from "../../stores/fileViewer";
import { useTerminalStore } from "../../stores/terminal";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import { LoadingState } from "../ui/EmptyState";
import { Page } from "../ui/Page";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { WorkspaceConsole, type WorkspaceTab } from "./WorkspaceConsole";
import { Spinner } from "../ui/Spinner";
import { WorkspaceEmptyState } from "./workspaceUi";
import "./workspace.css";

/**
 * 路径比较：只用于「这个目录是不是已经登记过」的友好提示。
 *
 * 渲染进程没有 Node 的 `process`（contextIsolation），这里不能读 platform；
 * 统一按大小写不敏感比较即可 —— 主进程才是重复校验的最终来源，
 * 它的 normalize 同样是全平台小写。
 */
function samePath(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

export function WorkspacesView() {
  const projects = useChatStore((s) => s.projects);
  const projectsLoaded = useChatStore((s) => s.projectsLoaded);
  const loadProjects = useChatStore((s) => s.loadProjects);
  const createProject = useChatStore((s) => s.createProject);
  const deleteProject = useChatStore((s) => s.deleteProject);
  const pickDirectory = useChatStore((s) => s.pickDirectory);
  const closeWorkspaceTerminals = useTerminalStore((s) => s.closeByWorkspace);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tabByProject, setTabByProject] = useState<
    Record<string, WorkspaceTab>
  >({});
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (projectsLoaded) return;
    void loadProjects().catch((err) => toast.error(toMessage(err), 5000));
  }, [projectsLoaded, loadProjects]);

  // 选中的工作区被删除 / 首次进入时，自动落到第一个
  useEffect(() => {
    if (!projectsLoaded) return;
    if (selectedId && projects.some((project) => project.id === selectedId)) {
      return;
    }
    setSelectedId(projects[0]?.id ?? null);
  }, [projects, projectsLoaded, selectedId]);

  /**
   * 列表不再为每个工作区预读 Git 状态。
   *
   * 之前会在进入页面时为全部工作区各跑一次 `git status`，大仓库
   * （几万个未跟踪文件）下会明显卡顿；现在只有选中工作区的控制台
   * 读取一次，列表项只展示名称与路径。
   */
  const selectedProject =
    projects.find((project) => project.id === selectedId) ?? null;

  // ==========================================================================
  // 动作
  // ==========================================================================

  const createWorkspace = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const cwd = await pickDirectory();
      if (!cwd) return;

      const existing = projects.find((project) => samePath(project.cwd, cwd));
      if (existing) {
        toast.success(`该目录已是工作区「${existing.name}」`);
        setSelectedId(existing.id);
        return;
      }

      const project = await createProject(dirNameOf(cwd), cwd);
      if (!project) throw new Error("创建工作区失败");
      setSelectedId(project.id);
      toast.success(`工作区「${project.name}」已创建`);
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setCreating(false);
    }
  };

  const removeWorkspace = async (project: Project) => {
    if (deletingId) return;

    const confirmed = await confirmDialog({
      title: `删除工作区「${project.name}」？`,
      message: [
        "将同时清理该工作区下的：",
        "· 会话",
        "· 工作流及其运行记录",
        "· .novastudio 产物",
        "",
        "工作区目录本身不会被删除。此操作不可恢复。",
      ].join("\n"),
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) return;

    setDeletingId(project.id);
    try {
      await deleteProject(project.id);
      closeWorkspaceTerminals(project.id);
      setTabByProject((current) => removeKey(current, project.id));
      toast.success(`工作区「${project.name}」已删除`);
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setDeletingId(null);
    }
  };

  const openFolder = async (project: Project) => {
    try {
      const opened = await ipc.revealProject(project.id);
      if (!opened) throw new Error("工作区目录不存在");
    } catch (err) {
      toast.error(toMessage(err), 5000);
    }
  };

  const openTerminal = (project: Project) => {
    const id = useTerminalStore.getState().open({
      workspaceId: project.id,
      cwd: project.cwd,
      name: project.name,
    });
    // 终端作为会话页中心区域的一个标签打开
    useFileViewerStore.getState().activateTab(id);
    useChatStore.getState().setViewMode("chat");
  };

  // ==========================================================================
  // 渲染
  // ==========================================================================

  if (!projectsLoaded) {
    return (
      <Page>
        <LoadingState text="正在加载工作区" className="h-full" />
      </Page>
    );
  }

  if (projects.length === 0) {
    return (
      <Page>
        <EmptyWorkspaces
          creating={creating}
          onCreate={() => void createWorkspace()}
        />
      </Page>
    );
  }

  return (
    <Page>
      <div className="flex min-h-0 flex-1">
        {/* 左：工作区列表 */}
        <aside className="ws-rail">
          <div className="ws-rail-head">
            <div className="flex min-w-0 items-center gap-2">
              <p className="ws-kicker truncate">工作区</p>
              <span className="ws-count">{projects.length}</span>
            </div>
            <IconButton
              icon={
                creating ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <FolderPlus className="h-4 w-4" />
                )
              }
              label="新建工作区"
              tone="muted"
              size="sm"
              disabled={creating}
              onClick={() => void createWorkspace()}
            />
          </div>

          <div className="ws-rail-list">
            {projects.map((project) => (
              <WorkspaceRailItem
                key={project.id}
                project={project}
                active={project.id === selectedId}
                onClick={() => setSelectedId(project.id)}
              />
            ))}
          </div>

          <div className="ws-rail-foot">
            <span>本地目录</span>
            <span>按需读取</span>
          </div>
        </aside>

        {/* 右：当前工作区控制台 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedProject ? (
            <WorkspaceConsole
              key={selectedProject.id}
              project={selectedProject}
              tab={tabByProject[selectedProject.id] ?? "files"}
              onTabChange={(tab) =>
                setTabByProject((current) => ({
                  ...current,
                  [selectedProject.id]: tab,
                }))
              }
              onOpenFolder={() => void openFolder(selectedProject)}
              onOpenTerminal={() => openTerminal(selectedProject)}
              onDelete={() => void removeWorkspace(selectedProject)}
            />
          ) : (
            <WorkspaceEmptyState
              icon={<FolderKanban className="h-5 w-5" />}
              title="选择一个工作区"
              description="从左侧选择目录，查看文件与 Git 变更。"
            />
          )}
        </div>
      </div>
    </Page>
  );
}

// ============================================================================
// 左侧列表项
// ============================================================================

function WorkspaceRailItem({
  project,
  active,
  onClick,
}: {
  project: Project;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={project.cwd}
      data-active={active}
      className="ws-rail-item"
    >
      <span className="ws-rail-icon">
        <Folder className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="ws-rail-name">{project.name}</span>
        <span className="ws-rail-path">{project.cwd}</span>
      </span>
      <ChevronRight className="ws-rail-chevron h-3.5 w-3.5" />
    </button>
  );
}

// ============================================================================
// 空态 / 工具
// ============================================================================

function EmptyWorkspaces({
  creating,
  onCreate,
}: {
  creating: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="ws-empty flex-1">
      <span className="ws-empty-icon">
        <FolderKanban className="h-5 w-5" />
      </span>
      <h2 className="ws-empty-title">先登记一个工作区</h2>
      <p className="ws-empty-desc">
        工作区是一个本地根目录，可以是代码仓库、Excel 资料库或知识库目录。
        登记后可以浏览全部文件、预览内容，并进行 Git 操作。
      </p>
      <Button
        variant="primary"
        className="mt-2"
        onClick={onCreate}
        disabled={creating}
        loading={creating}
        icon={<FolderPlus className="h-4 w-4" />}
      >
        选择文件夹创建
      </Button>
    </div>
  );
}

function dirNameOf(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "新工作区";
}

function removeKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}
