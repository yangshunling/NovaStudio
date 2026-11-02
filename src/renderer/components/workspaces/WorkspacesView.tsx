/**
 * 工作区管理页
 *
 * 工作区 = 一个本地根目录（复用项目实体）。这里是工作区唯一的「新增 / 删除」
 * 入口：工作流、会话绑定等页面只读取这份列表，不再各自创建。
 *
 * 删除工作区会级联清理它下面的会话、工作流、运行记录与 .novastudio 产物，
 * 但目录本身始终保留（主进程 deleteWorkspaceData 负责）。
 */

import { useEffect, useMemo, useState } from "react";
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
  type LucideIcon,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { dirName, timeAgo, toMessage } from "../../lib/utils";
import { useLoad } from "../../hooks/useLoad";
import { useChatStore } from "../../stores/chat";
import { useTerminalStore } from "../../stores/terminal";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import { formatAssetTime } from "../assets/assetUi";
import { EmptyState, ErrorState, LoadingState } from "../ui/EmptyState";
import { Page, PageBody } from "../ui/Page";
import { SearchInput } from "../ui/SearchInput";
import { Dialog, DialogActions } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, TextInput } from "../ui/Field";
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

  // 工作流用于统计每个工作区下的数量；项目/会话由各自的 store 提供
  const { data: workflows, error, reload, setData: setWorkflows } =
    useLoad(() => ipc.listWorkflows(), []);
  /** 首次进入：等项目/会话/工作流都就绪再结束骨架，避免列表先空后跳 */
  const [booting, setBooting] = useState(true);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  // 项目/会话由 store 提供（首次进入拉取）；工作流由 useLoad 挂载即拉
  useEffect(() => {
    void Promise.all([loadProjects(), loadSessions()])
      .catch(() => {
        // 各自失败由 store 内部处理
      })
      .finally(() => setBooting(false));
  }, [loadProjects, loadSessions]);

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
      toast.error(toMessage(err), 5000);
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
      toast.error(toMessage(err), 5000);
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

    const confirmed = await confirmDialog({
      title: `删除工作区「${project.name}」？`,
      message: [
        "将同时删除：",
        `· ${sessionCount} 个会话`,
        `· ${workflowCount} 个工作流及其运行记录`,
        "· 工作区下的 .novastudio 产物",
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
      // 工作区没了，它下面的终端也不再可用，一并关闭（渲染层会 kill PTY）
      closeWorkspaceTerminals(project.id);
      setWorkflows((current) =>
        current.filter((workflow) => workflow.workspaceId !== project.id),
      );
      toast.success(`工作区「${project.name}」已删除`);
    } catch (err) {
      toast.error(toMessage(err), 5000);
      // 删除可能部分完成（例如运行中的工作流阻止），重新拉取真实状态
      reload();
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Page>
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
          <SearchInput
            size="sm"
            widthClass="w-56"
            value={query}
            onChange={setQuery}
            placeholder="搜索名称 / 路径"
          />

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

      <PageBody>
          {booting ? (
            <LoadingState text="正在加载工作区" className="h-full" />
          ) : error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : projects.length === 0 ? (
            <EmptyWorkspaces
              creating={creating}
              onCreate={() => void createWorkspace()}
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Search />}
              title={`没有匹配「${query}」的工作区`}
              action={
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="text-meta text-accent hover:underline"
                >
                  清除搜索
                </button>
              }
            />
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
      </PageBody>

      <Dialog
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="重命名工作区"
        widthClass="w-[440px] max-w-[90vw]"
      >
        <p className="mb-3 break-all font-mono text-meta text-text-muted">
          {renameTarget?.cwd}
        </p>
        <Field
          label="名称"
          required
          hint="只修改工作区的展示名，不会重命名或移动本地目录。"
        >
          <TextInput
            autoFocus
            value={renameName}
            onChange={(event) => setRenameName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveRename();
            }}
          />
        </Field>
        <DialogActions>
          <Button onClick={() => setRenameTarget(null)}>取消</Button>
          <Button
            variant="primary"
            onClick={() => void saveRename()}
            disabled={!renameName.trim()}
            loading={renameBusy}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </Page>
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

function EmptyWorkspaces({
  creating,
  onCreate,
}: {
  creating: boolean;
  onCreate: () => void;
}) {
  return (
    <EmptyState
      icon={<FolderKanban />}
      title="先登记一个工作区"
      description="工作区是一个本地根目录。会话、工作流与运行产物都会落在里面；在这里登记一次，其他页面直接选用即可。"
      className="py-24"
      action={
        <Button
          variant="primary"
          onClick={onCreate}
          disabled={creating}
          loading={creating}
          icon={<FolderPlus className="h-4 w-4" />}
        >
          选择文件夹创建
        </Button>
      }
    />
  );
}
