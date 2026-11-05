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
  FolderOpen,
  FolderPlus,
  Loader2,
  MessageSquare,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { dirName, toMessage } from "../../lib/utils";
import { useLoad } from "../../hooks/useLoad";
import { useChatStore } from "../../stores/chat";
import { useTerminalStore } from "../../stores/terminal";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import {
  EmptyState,
  ErrorState,
  FilterEmpty,
  LoadingState,
} from "../ui/EmptyState";
import { Page, PageBody, PageHeader } from "../ui/Page";
import { Button } from "../ui/Button";
import {
  CARD_FOOTER,
  CARD_FOOTER_META,
  CARD_ICON_TILE,
  CARD_SHELL,
  CARD_TITLE,
} from "../ui/cardStyles";
import { SearchInput } from "../ui/SearchInput";
import type { Project } from "@shared/types";

/** 路径比较：Windows 下大小写与分隔符都不敏感，其他平台大小写敏感 */
function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const unified = value.replace(/\\/g, "/").replace(/\/+$/, "");
    // Linux / macOS 的 /home/a 与 /home/A 是两个不同目录，不能折叠大小写
    return process.platform === "win32" ? unified.toLowerCase() : unified;
  };
  return normalize(a) === normalize(b);
}

export function WorkspacesView() {
  // 工作区列表以 chat store 为唯一来源：其他页面绑定的项目也读同一份
  const projects = useChatStore((s) => s.projects);
  const sessions = useChatStore((s) => s.sessions);
  const loadProjects = useChatStore((s) => s.loadProjects);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const createProject = useChatStore((s) => s.createProject);
  const deleteProject = useChatStore((s) => s.deleteProject);
  const pickDirectory = useChatStore((s) => s.pickDirectory);
  const closeWorkspaceTerminals = useTerminalStore(
    (s) => s.closeByWorkspace,
  );

  // 工作流用于统计每个工作区下的数量；项目/会话由各自的 store 提供
  const { data: workflows, error, reload, setData: setWorkflows } =
    useLoad(() => ipc.listWorkflows(), []);
  /** 首次进入：等项目/会话/工作流都就绪再结束骨架，避免列表先空后跳 */
  const [booting, setBooting] = useState(true);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  /** 打开工作区：用系统文件管理器定位到工作区根目录 */
  const openWorkspace = async (project: Project) => {
    try {
      const opened = await ipc.revealProject(project.id);
      if (!opened) throw new Error("工作区目录不存在");
    } catch (err) {
      toast.error(toMessage(err), 5000);
    }
  };

  return (
    <Page>
      <PageHeader
        title="工作区"
        count={projects.length}
        countSuffix=" 个"
        icon={<FolderKanban className="h-4 w-4" />}
        actions={
          <>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="搜索名称 / 路径"
            />

            <Button
              variant="primary"
              onClick={() => void createWorkspace()}
              disabled={creating}
              icon={
                creating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FolderPlus className="h-4 w-4" />
                )
              }
            >
              新建工作区
            </Button>
          </>
        }
      />

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
            <FilterEmpty
              title={`没有匹配「${query}」的工作区`}
              onClear={() => setQuery("")}
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((project) => (
                <WorkspaceCard
                  key={project.id}
                  project={project}
                  sessionCount={sessionCounts.get(project.id) ?? 0}
                  workflowCount={workflowCounts.get(project.id) ?? 0}
                  deleting={deletingId === project.id}
                  onOpen={() => void openWorkspace(project)}
                  onDelete={() => void removeWorkspace(project)}
                />
              ))}
            </div>
          )}
      </PageBody>
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
  onOpen,
  onDelete,
}: {
  project: Project;
  sessionCount: number;
  workflowCount: number;
  deleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={CARD_SHELL}>
      <div className="flex items-start gap-3">
        <span className={CARD_ICON_TILE}>
          <Folder className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className={CARD_TITLE} title={project.name}>
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

      {/* 会话 / 工作流数量在左，操作按钮在右，与触发器/工作流卡片一致 */}
      <div className={CARD_FOOTER}>
        <div className={CARD_FOOTER_META}>
          <span
            title={`${sessionCount} 个会话`}
            className="flex items-center gap-1 rounded-full bg-agent-teal/10 px-2 py-0.5 text-agent-teal"
          >
            <MessageSquare className="h-3 w-3" />
            {sessionCount} 个会话
          </span>
          <span
            title={`${workflowCount} 个工作流`}
            className="flex items-center gap-1 rounded-full bg-agent-amber/10 px-2 py-0.5 text-agent-amber"
          >
            <WorkflowIcon className="h-3 w-3" />
            {workflowCount} 个工作流
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            icon={<FolderOpen className="h-3.5 w-3.5" />}
            onClick={onOpen}
            disabled={deleting}
            title="在文件管理器中打开工作区目录"
          >
            打开
          </Button>
          <Button
            size="xs"
            variant="dangerLink"
            icon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={onDelete}
            disabled={deleting}
          >
            删除
          </Button>
        </div>
      </div>
    </div>
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
