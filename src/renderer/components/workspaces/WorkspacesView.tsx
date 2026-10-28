/**
 * 工作区管理页
 *
 * 工作区 = 一个本地根目录（复用项目实体）。这里是工作区唯一的「新增 / 删除」
 * 入口：工作流、会话绑定等页面只读取这份列表，不再各自创建。
 *
 * 删除工作区会级联清理它下面的会话、工作流、运行记录与 .novastudio 产物，
 * 但目录本身始终保留（主进程 deleteWorkspaceData 负责）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Folder,
  FolderKanban,
  FolderPlus,
  Loader2,
  MessageSquare,
  PenLine,
  Search,
  SquareTerminal,
  Trash2,
  Workflow as WorkflowIcon,
  X,
  type LucideIcon,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { useChatStore } from "../../stores/chat";
import { useTerminalStore } from "../../stores/terminal";
import { toast } from "../../stores/toast";
import { dirName, timeAgo } from "../../lib/utils";
import { formatAssetTime } from "../assets/assetUi";
import { Modal, ModalHeader } from "../ui/Modal";
import { FORM_INPUT_CLASS } from "../ui/Field";
import type { Project, Workflow } from "@shared/types";

/** 路径比较：Windows 下大小写与分隔符都不敏感 */
function samePath(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

export function WorkspacesView() {
  // 工作区列表以 chat store 为唯一来源：其他页面绑定的项目也读同一份
  const projects = useChatStore((s) => s.projects);
  const sessions = useChatStore((s) => s.sessions);
  const loadProjects = useChatStore((s) => s.loadProjects);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const createProject = useChatStore((s) => s.createProject);
  const renameProject = useChatStore((s) => s.renameProject);
  const deleteProject = useChatStore((s) => s.deleteProject);
  const pickDirectory = useChatStore((s) => s.pickDirectory);
  const setViewMode = useChatStore((s) => s.setViewMode);
  const openTerminal = useTerminalStore((s) => s.open);
  const closeWorkspaceTerminals = useTerminalStore(
    (s) => s.closeByWorkspace,
  );
  const renameWorkspaceTerminal = useTerminalStore(
    (s) => s.renameByWorkspace,
  );

  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  const loadWorkflows = useCallback(async () => {
    try {
      setWorkflows(await ipc.listWorkflows());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // 进入页面时统一刷新：项目与会话由 store 提供，工作流用于统计数量
    void Promise.all([loadProjects(), loadSessions(), loadWorkflows()])
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [loadProjects, loadSessions, loadWorkflows]);

  const sessionCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const session of sessions) {
      if (!session.projectId) continue;
      map.set(session.projectId, (map.get(session.projectId) ?? 0) + 1);
    }
    return map;
  }, [sessions]);

  const workflowCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const workflow of workflows) {
      map.set(
        workflow.workspaceId,
        (map.get(workflow.workspaceId) ?? 0) + 1,
      );
    }
    return map;
  }, [workflows]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return projects;
    return projects.filter((project) =>
      [project.name, project.cwd].some((value) =>
        value.toLowerCase().includes(keyword),
      ),
    );
  }, [projects, query]);

  /** 新增工作区：选一个目录登记为项目；已登记的目录直接提示，不重复创建 */
  const createWorkspace = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const cwd = await pickDirectory();
      if (!cwd) return;

      const existing = projects.find((project) => samePath(project.cwd, cwd));
      if (existing) {
        toast.success(`该目录已是工作区「${existing.name}」`);
        return;
      }

      const project = await createProject(dirName(cwd), cwd);
      if (!project) throw new Error("创建工作区失败");
      toast.success(`工作区「${project.name}」已创建`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 5000);
    } finally {
      setCreating(false);
    }
  };

  /** 在工作区打开终端：定位到该目录 */
  const openWorkspaceTerminal = (project: Project) => {
    openTerminal({
      workspaceId: project.id,
      cwd: project.cwd,
      name: project.name,
    });
    setViewMode("terminals");
  };

  const openRename = (project: Project) => {
    setRenameTarget(project);
    setRenameName(project.name);
  };

  const saveRename = async () => {
    if (!renameTarget || !renameName.trim() || renameBusy) return;
    setRenameBusy(true);
    try {
      const name = renameName.trim();
      await renameProject(renameTarget.id, name);
      // 终端标题是工作区名的快照，改名后同步，避免两个页面显示不一致
      renameWorkspaceTerminal(renameTarget.id, name);
      setRenameTarget(null);
      toast.success("工作区名称已更新");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 5000);
    } finally {
      setRenameBusy(false);
    }
  };

  /**
   * 删除工作区：主进程会级联清理工作流、运行记录、节点会话与 .novastudio
   * 产物；目录本身不动。
   */
  const removeWorkspace = async (project: Project) => {
    if (deletingId) return;
    const sessionCount = sessionCounts.get(project.id) ?? 0;
    const workflowCount = workflowCounts.get(project.id) ?? 0;

    const confirmed = window.confirm(
      [
        `删除工作区「${project.name}」？`,
        "",
        "将同时删除：",
        `· ${sessionCount} 个会话`,
        `· ${workflowCount} 个工作流及其运行记录`,
        "· 工作区下的 .novastudio 产物",
        "",
        "工作区目录本身不会被删除。此操作不可恢复。",
      ].join("\n"),
    );
    if (!confirmed) return;

    setDeletingId(project.id);
    try {
      await deleteProject(project.id);
      // 工作区没了，它下面的终端也不再可用，一并关闭（渲染层会 kill PTY）
      closeWorkspaceTerminals(project.id);
      setWorkflows((current) =>
        current.filter((workflow) => workflow.workspaceId !== project.id),
      );
      toast.success(`工作区「${project.name}」已删除`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 5000);
      // 删除可能部分完成（例如运行中的工作流阻止），重新拉取真实状态
      void loadWorkflows();
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden">
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-3 border-b border-border px-card">
          <div className="flex min-w-0 items-center gap-2.5">
            <FolderKanban className="h-4 w-4 shrink-0 text-accent" />
            <div className="min-w-0">
              <p className="truncate text-title font-semibold text-text">工作区</p>
              <p className="truncate text-caption text-text-muted">
                统一登记本地目录；会话与工作流都以它为根
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 font-mono text-caption text-text-muted">
              {projects.length} 个
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <div className="ui-ring flex h-8 w-56 items-center gap-1.5 rounded-full bg-input-bg px-3">
              <Search className="h-3.5 w-3.5 shrink-0 text-text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称 / 路径"
                className="min-w-0 flex-1 bg-transparent text-body text-text placeholder-text-muted outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  title="清除搜索"
                  className="shrink-0 rounded-full p-0.5 text-text-muted transition-colors hover:text-text"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => void createWorkspace()}
              disabled={creating}
              className="ui-btn-primary flex h-8 shrink-0 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95 disabled:opacity-60"
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FolderPlus className="h-4 w-4" />
              )}
              新建工作区
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-section">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-body text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载工作区
            </div>
          ) : error ? (
            <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
              <p className="text-body text-error">{error}</p>
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  void loadWorkflows().finally(() => setLoading(false));
                }}
                className="ui-btn-ghost rounded-lg px-3 py-2 text-meta"
              >
                重新加载
              </button>
            </div>
          ) : projects.length === 0 ? (
            <EmptyState creating={creating} onCreate={() => void createWorkspace()} />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center text-text-muted">
              <Search className="h-6 w-6 opacity-50" />
              <p className="text-body">没有匹配「{query}」的工作区</p>
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-meta text-accent hover:underline"
              >
                清除搜索
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((project) => (
                <WorkspaceCard
                  key={project.id}
                  project={project}
                  sessionCount={sessionCounts.get(project.id) ?? 0}
                  workflowCount={workflowCounts.get(project.id) ?? 0}
                  deleting={deletingId === project.id}
                  onTerminal={() => openWorkspaceTerminal(project)}
                  onRename={() => openRename(project)}
                  onDelete={() => void removeWorkspace(project)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        widthClass="w-[440px] max-w-[90vw]"
      >
        <div className="p-card">
          <ModalHeader
            title="重命名工作区"
            onClose={() => setRenameTarget(null)}
          />
          <p className="mb-3 break-all font-mono text-meta text-text-muted">
            {renameTarget?.cwd}
          </p>
          <label className="mb-1.5 block text-meta font-medium text-text-secondary">
            名称
          </label>
          <input
            autoFocus
            value={renameName}
            onChange={(event) => setRenameName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveRename();
            }}
            className={FORM_INPUT_CLASS}
          />
          <p className="mt-1.5 text-meta leading-relaxed text-text-muted">
            只修改工作区的展示名，不会重命名或移动本地目录。
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setRenameTarget(null)}
              className="ui-btn-ghost h-9 rounded-full px-4 text-body font-medium active:scale-95"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void saveRename()}
              disabled={!renameName.trim() || renameBusy}
              className="ui-btn-primary flex h-9 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95 disabled:opacity-50"
            >
              {renameBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              保存
            </button>
          </div>
        </div>
      </Modal>
    </main>
  );
}

// ============================================================================
// 工作区卡片
// ============================================================================

function WorkspaceCard({
  project,
  sessionCount,
  workflowCount,
  deleting,
  onTerminal,
  onRename,
  onDelete,
}: {
  project: Project;
  sessionCount: number;
  workflowCount: number;
  deleting: boolean;
  onTerminal: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-surface-2/60 p-card shadow-[var(--c-shadow-sm)] transition-all hover:border-border-strong hover:bg-surface-2/85 hover:shadow-[var(--c-shadow)]">
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
          <Folder className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-heading font-semibold text-text">
            {project.name}
          </h3>
          <p
            className="mt-1 break-all font-mono text-caption leading-relaxed text-text-muted"
            title={project.cwd}
          >
            {project.cwd}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-meta text-text-muted">
        <span className="flex items-center gap-1 rounded-full bg-surface-hover px-2.5 py-0.5">
          <MessageSquare className="h-3 w-3" />
          {sessionCount} 个会话
        </span>
        <span className="flex items-center gap-1 rounded-full bg-surface-hover px-2.5 py-0.5">
          <WorkflowIcon className="h-3 w-3" />
          {workflowCount} 个工作流
        </span>
      </div>

      <div className="mt-auto flex items-center gap-1 pt-3">
        <button
          type="button"
          onClick={onTerminal}
          title="在此目录打开终端"
          className="ui-ring flex items-center gap-1 rounded-full bg-surface-hover px-2.5 py-1 text-meta text-text-secondary transition-colors hover:bg-surface-active hover:text-text"
        >
          <SquareTerminal className="h-3.5 w-3.5" />
          终端
        </button>
        <span
          className="ml-auto text-caption text-text-muted"
          title={formatAssetTime(project.updatedAt)}
        >
          更新于 {timeAgo(project.updatedAt)}
        </span>
        <ActionButton icon={PenLine} label="重命名" onClick={onRename} />
        <ActionButton
          icon={Trash2}
          label="删除工作区"
          danger
          disabled={deleting}
          onClick={onDelete}
        />
      </div>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  danger = false,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`ui-ring rounded-md p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? "text-text-muted hover:bg-error-bg hover:text-error"
          : "text-text-muted hover:bg-surface-hover hover:text-text"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function EmptyState({
  creating,
  onCreate,
}: {
  creating: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-24 text-center text-text-muted">
      <div className="ui-btn-round flex h-16 w-16 items-center justify-center rounded-2xl">
        <FolderKanban className="h-6 w-6" />
      </div>
      <h2 className="ui-serif text-heading font-semibold text-text-secondary">
        先登记一个工作区
      </h2>
      <p className="text-body leading-relaxed">
        工作区是一个本地根目录。会话、工作流与运行产物都会落在里面；
        在这里登记一次，其他页面直接选用即可。
      </p>
      <button
        type="button"
        onClick={onCreate}
        disabled={creating}
        className="ui-btn-primary mt-2 flex items-center gap-1.5 rounded-full px-4 py-2 text-body font-medium disabled:opacity-60"
      >
        {creating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <FolderPlus className="h-4 w-4" />
        )}
        选择文件夹创建
      </button>
    </div>
  );
}
