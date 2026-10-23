/**
 * 工作流工作台
 *
 * 两级导航：
 * - 左：工作区列表（复用项目：一个根目录 + 名字）
 * - 右：当前工作区下的工作流卡片；点击卡片进入编辑器
 *
 * 工作流必须归属于一个工作区，运行时的 cwd 与产物目录都由工作区决定。
 * 「未归属」是历史数据的兜底分组：旧工作流没有 workspace_id 时展示在这里。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Folder,
  FolderPlus,
  History,
  Loader2,
  MoreHorizontal,
  PenLine,
  Play,
  Plus,
  Search,
  SquarePen,
  Trash2,
  Workflow as WorkflowIcon,
  X,
  type LucideIcon,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { dirName, newId, timeAgo } from "../../lib/utils";
import { useChatStore } from "../../stores/chat";
import { toast } from "../../stores/toast";
import { Modal, ModalHeader } from "../ui/Modal";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowRunView } from "./WorkflowRunView";
import { WorkflowRunHistoryView } from "./WorkflowRunHistoryView";
import { defaultNodeConfig } from "./defaults";
import type {
  DigitalEmployee,
  Project,
  Workflow,
  WorkflowGraph,
} from "@shared/types";

/** 未归属分组的伪工作区 id；真实工作区 id 都是 uuid，不会冲突 */
const ORPHAN_ID = "__orphan__";

/** 新建工作流时预置开始 / 结束两个锚点，画布不至于空得没有参照 */
function seedGraph(): WorkflowGraph {
  return {
    nodes: [
      {
        id: newId(),
        type: "start",
        name: "开始",
        position: { x: 120, y: 140 },
        config: defaultNodeConfig(),
      },
      {
        id: newId(),
        type: "end",
        name: "结束",
        position: { x: 720, y: 140 },
        config: defaultNodeConfig(),
      },
    ],
    edges: [],
  };
}

export function WorkflowsView() {
  const [workspaces, setWorkspaces] = useState<Project[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [employees, setEmployees] = useState<DigitalEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 从卡片进入调试时，把已启动的 runId 带进编辑器 */
  const [editorDebugRunId, setEditorDebugRunId] = useState<string | null>(null);
  /** 正在查看的运行：记录来源工作流，返回时回到编辑器 */
  const [running, setRunning] = useState<{
    runId: string;
    workflowId: string;
  } | null>(null);

  const [renameTarget, setRenameTarget] = useState<Workflow | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameDescription, setRenameDescription] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  const [creatingWorkflow, setCreatingWorkflow] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(
    null,
  );
  /** 运行记录列表的作用域：工作流级或工作区级 */
  const [historyScope, setHistoryScope] = useState<
    { workflowId: string } | { workspaceId: string } | null
  >(null);

  const load = useCallback(async () => {
    try {
      const [workflowList, employeeList, workspaceList] = await Promise.all([
        ipc.listWorkflows(),
        ipc.listEmployees(),
        ipc.listProjects(),
      ]);
      setWorkflows(workflowList);
      setEmployees(employeeList);
      setWorkspaces(workspaceList);
      setSelectedWorkspaceId((current) =>
        current && workspaceList.some((item) => item.id === current)
          ? current
          : (workspaceList[0]?.id ?? null),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 历史遗留：没有归属任何现有工作流的工作流 */
  const orphanWorkflows = useMemo(
    () =>
      workflows.filter(
        (workflow) =>
          !workspaces.some((workspace) => workspace.id === workflow.workspaceId),
      ),
    [workflows, workspaces],
  );

  const workspaceOptions = useMemo<Project[]>(() => {
    if (orphanWorkflows.length === 0) return workspaces;
    return [
      ...workspaces,
      {
        id: ORPHAN_ID,
        name: "未归属",
        cwd: "",
        createdAt: 0,
        updatedAt: 0,
      },
    ];
  }, [workspaces, orphanWorkflows.length]);

  const effectiveWorkspaceId =
    selectedWorkspaceId &&
    workspaceOptions.some((item) => item.id === selectedWorkspaceId)
      ? selectedWorkspaceId
      : (workspaceOptions[0]?.id ?? null);

  const selectedWorkspace =
    workspaceOptions.find((item) => item.id === effectiveWorkspaceId) ?? null;

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const workflow of workflows) {
      map.set(workflow.workspaceId, (map.get(workflow.workspaceId) ?? 0) + 1);
    }
    return map;
  }, [workflows]);

  const selectedWorkflows = useMemo(() => {
    if (effectiveWorkspaceId === ORPHAN_ID) return orphanWorkflows;
    return workflows.filter(
      (workflow) => workflow.workspaceId === effectiveWorkspaceId,
    );
  }, [workflows, effectiveWorkspaceId, orphanWorkflows]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return selectedWorkflows;
    return selectedWorkflows.filter((workflow) =>
      [workflow.name, workflow.description].some((value) =>
        value.toLowerCase().includes(keyword),
      ),
    );
  }, [selectedWorkflows, query]);

  const editing = workflows.find((workflow) => workflow.id === editingId) ?? null;

  const selectWorkspace = (id: string) => {
    setSelectedWorkspaceId(id);
    setQuery("");
  };

  /** 新建工作区 = 选一个目录并登记为项目（与侧栏「新建项目」同源） */
  const createWorkspace = async () => {
    if (creatingWorkspace) return;
    const cwd = await ipc.pickDirectory();
    if (!cwd) return;

    const existing = workspaces.find((workspace) => workspace.cwd === cwd);
    if (existing) {
      selectWorkspace(existing.id);
      return;
    }

    setCreatingWorkspace(true);
    try {
      // 走 chat store，保证全局侧栏的项目列表同步更新
      const project = await useChatStore.getState().createProject(dirName(cwd), cwd);
      if (!project) {
        throw new Error("创建工作区失败");
      }
      setWorkspaces((current) => [...current, project]);
      selectWorkspace(project.id);
      setError(null);
      toast.success(`工作区「${project.name}」已创建`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(`创建工作区失败：${message}`);
    } finally {
      setCreatingWorkspace(false);
    }
  };

  /**
   * 删除工作区（= 项目）。
   * 主进程会级联清理工作流、运行记录、节点会话、.novastudio 产物与运行配置副本，
   * 但不会删除工作区目录本身。
   */
  const deleteWorkspace = async (workspace: Project) => {
    if (workspace.id === ORPHAN_ID || deletingWorkspaceId) return;
    const count = counts.get(workspace.id) ?? 0;

    const confirmed = window.confirm(
      [
        `删除工作区「${workspace.name}」？`,
        "",
        "将同时删除：",
        `· ${count} 个工作流`,
        "· 全部运行记录与节点会话",
        "· 工作区下的 .novastudio 产物",
        "",
        "工作区目录本身不会被删除。此操作不可恢复。",
      ].join("\n"),
    );
    if (!confirmed) return;

    setDeletingWorkspaceId(workspace.id);
    try {
      // 走 chat store，侧栏会同步移除项目、清理当前选中状态
      await useChatStore.getState().deleteProject(workspace.id);
      toast.success(`工作区「${workspace.name}」已删除`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 5000);
    } finally {
      setDeletingWorkspaceId(null);
    }
  };

  const openCreateWorkflow = () => {
    if (!selectedWorkspace || selectedWorkspace.id === ORPHAN_ID) return;
    setNewName("");
    setNewDescription("");
    setCreatingWorkflow(true);
  };

  const createWorkflow = async () => {
    if (
      !newName.trim() ||
      busy ||
      !selectedWorkspace ||
      selectedWorkspace.id === ORPHAN_ID
    ) {
      return;
    }
    setBusy(true);
    try {
      const workflow = await ipc.createWorkflow({
        workspaceId: selectedWorkspace.id,
        name: newName.trim(),
        description: newDescription.trim(),
        graph: seedGraph(),
      });
      setWorkflows((current) => [workflow, ...current]);
      setCreatingWorkflow(false);
      setEditorDebugRunId(null);
      setEditingId(workflow.id);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(`创建工作流失败：${message}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteWorkflow = async (workflow: Workflow) => {
    const confirmed = window.confirm(
      [
        `删除工作流「${workflow.name}」？`,
        "",
        "将同时删除它的运行记录、节点会话与 .novastudio 产物。",
        "此操作不可恢复。",
      ].join("\n"),
    );
    if (!confirmed) return;
    try {
      await ipc.deleteWorkflow(workflow.id);
      setWorkflows((current) => current.filter((item) => item.id !== workflow.id));
      if (editingId === workflow.id) setEditingId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 卡片操作：编辑 / 调试 / 复制 / 重命名 */
  const openEditor = (workflow: Workflow) => {
    setEditorDebugRunId(null);
    setEditingId(workflow.id);
  };

  const debugWorkflow = async (workflow: Workflow) => {
    // 先回到编辑器，再启动调试：失败时用户能直接看到编辑器并修正
    setEditorDebugRunId(null);
    setEditingId(workflow.id);
    try {
      const run = await ipc.startWorkflowRun(workflow.id);
      setEditorDebugRunId(run.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 6000);
    }
  };

  const duplicateWorkflow = async (workflow: Workflow) => {
    try {
      const copy = await ipc.createWorkflow({
        workspaceId: workflow.workspaceId,
        name: `${workflow.name} 副本`,
        description: workflow.description,
        graph: JSON.parse(JSON.stringify(workflow.graph)),
      });
      setWorkflows((current) => [copy, ...current]);
      toast.success("已复制工作流");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const openRename = (workflow: Workflow) => {
    setRenameTarget(workflow);
    setRenameName(workflow.name);
    setRenameDescription(workflow.description);
  };

  const saveRename = async () => {
    if (!renameTarget || !renameName.trim() || renameBusy) return;
    setRenameBusy(true);
    try {
      const updated = await ipc.updateWorkflow(renameTarget.id, {
        workspaceId: renameTarget.workspaceId,
        name: renameName.trim(),
        description: renameDescription.trim(),
        graph: renameTarget.graph,
      });
      if (updated) {
        setWorkflows((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
        setRenameTarget(null);
        toast.success("工作流已更新");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRenameBusy(false);
    }
  };

  if (running) {
    return (
      <WorkflowRunView
        key={running.runId}
        runId={running.runId}
        onBack={() => {
          // 返回运行记录列表；列表作用域仍然保留
          setRunning(null);
          void load();
        }}
      />
    );
  }

  if (historyScope) {
    const scopedWorkflow =
      "workflowId" in historyScope
        ? workflows.find((item) => item.id === historyScope.workflowId)
        : null;
    const scopedWorkspace =
      "workspaceId" in historyScope
        ? workspaces.find((item) => item.id === historyScope.workspaceId)
        : null;

    return (
      <WorkflowRunHistoryView
        title={
          scopedWorkflow
            ? `运行记录 · ${scopedWorkflow.name}`
            : `运行记录 · ${scopedWorkspace?.name ?? ""}`
        }
        workflowId={
          "workflowId" in historyScope ? historyScope.workflowId : undefined
        }
        workspaceId={
          "workspaceId" in historyScope ? historyScope.workspaceId : undefined
        }
        onBack={() => {
          const scope = historyScope;
          setHistoryScope(null);
          // 工作流级入口回到该工作流的编辑器
          if ("workflowId" in scope) {
            setEditorDebugRunId(null);
            setEditingId(scope.workflowId);
          }
        }}
        onOpenRun={(runId, workflowId) => setRunning({ runId, workflowId })}
      />
    );
  }

  if (editing) {
    return (
      <WorkflowEditor
        key={editing.id}
        workflow={editing}
        workspaces={workspaces}
        employees={employees}
        initialDebugRunId={editorDebugRunId}
        onBack={() => {
          setEditingId(null);
          setEditorDebugRunId(null);
        }}
        onSaved={(updated) => {
          setWorkflows((current) =>
            current.map((item) => (item.id === updated.id ? updated : item)),
          );
          setEditingId(null);
          setEditorDebugRunId(null);
          toast.success("工作流已保存");
        }}
        onDraftSaved={(updated) => {
          setWorkflows((current) =>
            current.map((item) => (item.id === updated.id ? updated : item)),
          );
        }}
        onOpenHistory={() => setHistoryScope({ workflowId: editing.id })}
      />
    );
  }

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden rounded-xl">
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
                void load();
              }}
              className="ui-btn-ghost rounded-lg px-3 py-2 text-meta"
            >
              重新加载
            </button>
          </div>
        ) : workspaceOptions.length === 0 ? (
          <NoWorkspaceState
            creating={creatingWorkspace}
            onCreate={() => void createWorkspace()}
          />
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* 左：工作区列表 */}
            <aside className="flex w-[268px] shrink-0 flex-col border-r border-border bg-surface-2/25">
              <div className="flex items-center justify-between px-4 pb-2 pt-4">
                <p className="text-meta font-semibold tracking-wide text-text-muted">
                  工作区
                </p>
                <button
                  type="button"
                  onClick={() => void createWorkspace()}
                  disabled={creatingWorkspace}
                  title="新建工作区"
                  className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text active:scale-95 disabled:opacity-50"
                >
                  {creatingWorkspace ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FolderPlus className="h-4 w-4" />
                  )}
                </button>
              </div>

              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-4">
                {workspaceOptions.map((workspace) => {
                  const active = workspace.id === effectiveWorkspaceId;
                  const isOrphan = workspace.id === ORPHAN_ID;
                  const count = isOrphan
                    ? orphanWorkflows.length
                    : (counts.get(workspace.id) ?? 0);

                  return (
                    <div
                      key={workspace.id}
                      className={`group flex w-full items-center rounded-xl transition-colors ${
                        active
                          ? "ui-active bg-surface-active text-text"
                          : "text-text-secondary hover:bg-surface-hover hover:text-text"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => selectWorkspace(workspace.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 px-2.5 py-2.5 text-left"
                      >
                        <span
                          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
                            active
                              ? "bg-accent-soft text-accent"
                              : "bg-surface-hover text-text-muted"
                          }`}
                        >
                          <Folder className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body-lg font-medium">
                            {workspace.name}
                          </span>
                          <span className="block truncate font-mono text-caption text-text-muted">
                            {isOrphan ? "旧数据，待归入工作区" : workspace.cwd}
                          </span>
                        </span>
                        <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 font-mono text-caption text-text-muted">
                          {count}
                        </span>
                      </button>

                      {!isOrphan && (
                        <button
                          type="button"
                          onClick={() => void deleteWorkspace(workspace)}
                          disabled={deletingWorkspaceId === workspace.id}
                          title="删除工作区"
                          className="mr-1.5 shrink-0 rounded-lg p-1.5 text-text-muted opacity-0 transition-all hover:bg-error-bg hover:text-error group-hover:opacity-100 disabled:opacity-100"
                        >
                          {deletingWorkspaceId === workspace.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}

                <button
                  type="button"
                  onClick={() => void createWorkspace()}
                  disabled={creatingWorkspace}
                  className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-2.5 text-meta text-text-muted transition-colors hover:border-border-strong hover:text-text disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  新建工作区
                </button>
              </div>
            </aside>

            {/* 右：当前工作区的工作流 */}
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-3 border-b border-border px-card">
                <div className="flex min-w-0 items-center gap-2.5">
                  <WorkflowIcon className="h-4 w-4 shrink-0 text-accent" />
                  <div className="min-w-0">
                    <p className="truncate text-title font-semibold text-text">
                      {selectedWorkspace?.name ?? "工作流"}
                    </p>
                    {selectedWorkspace && selectedWorkspace.id !== ORPHAN_ID && (
                      <p
                        className="truncate font-mono text-caption text-text-muted"
                        title={selectedWorkspace.cwd}
                      >
                        {selectedWorkspace.cwd}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 font-mono text-caption text-text-muted">
                    {selectedWorkflows.length} 个
                  </span>
                </div>

                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      effectiveWorkspaceId &&
                      effectiveWorkspaceId !== ORPHAN_ID &&
                      setHistoryScope({ workspaceId: effectiveWorkspaceId })
                    }
                    disabled={
                      !selectedWorkspace || selectedWorkspace.id === ORPHAN_ID
                    }
                    title="查看该工作区的运行记录"
                    className="ui-btn-ghost flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95 disabled:opacity-50"
                  >
                    <History className="h-4 w-4" />
                    运行记录
                  </button>

                  <div className="ui-ring flex h-8 w-52 items-center gap-1.5 rounded-full bg-input-bg px-3">
                    <Search className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索名称 / 说明"
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
                    onClick={openCreateWorkflow}
                    disabled={!selectedWorkspace || selectedWorkspace.id === ORPHAN_ID}
                    className="ui-btn-primary flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95 disabled:opacity-50"
                  >
                    <Plus className="h-4 w-4" />
                    新建工作流
                  </button>
                </div>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto p-section">
                {selectedWorkspace?.id === ORPHAN_ID ? (
                  <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center text-text-muted">
                    <Folder className="h-6 w-6 opacity-50" />
                    <p className="text-body leading-relaxed">
                      这些工作流创建于「工作区」功能之前，还没有归属。
                      请先新建工作区，再把它们重新归入。
                    </p>
                    <button
                      type="button"
                      onClick={() => void createWorkspace()}
                      className="ui-btn-primary mt-1 flex items-center gap-1.5 rounded-full px-4 py-2 text-body font-medium"
                    >
                      <FolderPlus className="h-4 w-4" />
                      新建工作区
                    </button>
                  </div>
                ) : selectedWorkflows.length === 0 ? (
                  <EmptyState onCreate={openCreateWorkflow} />
                ) : filtered.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-20 text-center text-text-muted">
                    <Search className="h-6 w-6 opacity-50" />
                    <p className="text-body">没有匹配「{query}」的工作流</p>
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      className="text-meta text-accent hover:underline"
                    >
                      清除搜索
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                    {filtered.map((workflow) => (
                      <WorkflowCard
                        key={workflow.id}
                        workflow={workflow}
                        onOpen={() => openEditor(workflow)}
                        onDebug={() => void debugWorkflow(workflow)}
                        onHistory={() =>
                          setHistoryScope({ workflowId: workflow.id })
                        }
                        onRename={() => openRename(workflow)}
                        onDuplicate={() => void duplicateWorkflow(workflow)}
                        onDelete={() => void deleteWorkflow(workflow)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <Modal
        open={creatingWorkflow}
        onClose={() => setCreatingWorkflow(false)}
        widthClass="w-[440px] max-w-[90vw]"
      >
        <div className="p-card">
          <ModalHeader
            title="新建工作流"
            onClose={() => setCreatingWorkflow(false)}
          />
          <p className="mb-4 text-body leading-relaxed text-text-muted">
            将在工作区「{selectedWorkspace?.name}」下创建。创建后进入画布，
            从左侧点击节点或数字员工，把它们连成一条流水线。
          </p>

          <label className="mb-1.5 block text-meta font-medium text-text-secondary">
            名称
          </label>
          <input
            autoFocus
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createWorkflow();
            }}
            placeholder="例如：需求分析到代码修改"
            className="ui-ring mb-3 w-full rounded-lg bg-input-bg px-3 py-2 text-body-lg text-text placeholder-text-muted outline-none transition-colors focus:border-input-border-focus"
          />

          <label className="mb-1.5 block text-meta font-medium text-text-secondary">
            说明（可选）
          </label>
          <textarea
            value={newDescription}
            onChange={(event) => setNewDescription(event.target.value)}
            rows={2}
            placeholder="这条流水线解决什么问题"
            className="ui-ring w-full resize-none rounded-lg bg-input-bg px-3 py-2 text-body-lg text-text placeholder-text-muted outline-none transition-colors focus:border-input-border-focus"
          />

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreatingWorkflow(false)}
              className="ui-btn-ghost h-9 rounded-full px-4 text-body font-medium active:scale-95"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void createWorkflow()}
              disabled={!newName.trim() || busy}
              className="ui-btn-primary flex h-9 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              创建
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        widthClass="w-[440px] max-w-[90vw]"
      >
        <div className="p-card">
          <ModalHeader
            title="编辑工作流信息"
            onClose={() => setRenameTarget(null)}
          />

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
            className="ui-ring mb-3 w-full rounded-lg bg-input-bg px-3 py-2 text-body-lg text-text placeholder-text-muted outline-none transition-colors focus:border-input-border-focus"
          />

          <label className="mb-1.5 block text-meta font-medium text-text-secondary">
            说明（可选）
          </label>
          <textarea
            value={renameDescription}
            onChange={(event) => setRenameDescription(event.target.value)}
            rows={3}
            placeholder="这条流水线解决什么问题"
            className="ui-ring w-full resize-none rounded-lg bg-input-bg px-3 py-2 text-body-lg text-text placeholder-text-muted outline-none transition-colors focus:border-input-border-focus"
          />

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
              className="ui-btn-primary flex h-9 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95"
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
// 工作流卡片
// ============================================================================

function WorkflowCard({
  workflow,
  onOpen,
  onDebug,
  onHistory,
  onRename,
  onDuplicate,
  onDelete,
}: {
  workflow: Workflow;
  onOpen: () => void;
  onDebug: () => void;
  onHistory: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 更多菜单：外部点击 / Esc 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const action = (fn: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    setMenuOpen(false);
    fn();
  };

  const nodeCount = workflow.graph.nodes.length;
  const employeeIds = new Set(
    workflow.graph.nodes
      .filter((node) => node.type === "employee" && node.config.employeeId)
      .map((node) => node.config.employeeId),
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        // 只响应卡片本身，不拦截内部操作按钮的键盘事件
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group relative flex h-full cursor-pointer flex-col rounded-xl border border-border bg-surface-2/60 p-card text-left transition-all hover:-translate-y-0.5 hover:border-border-strong hover:bg-surface-2/85 hover:shadow-[var(--c-shadow-sm)]"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
          <WorkflowIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-heading font-semibold text-text">
            {workflow.name}
          </h3>
          <p className="mt-1 line-clamp-2 text-body leading-relaxed text-text-muted">
            {workflow.description || "暂无说明"}
          </p>
        </div>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3 text-meta text-text-muted">
        <span className="rounded-full bg-surface-hover px-2.5 py-0.5">
          {nodeCount} 个节点
        </span>
        <span className="rounded-full bg-surface-hover px-2.5 py-0.5">
          {employeeIds.size} 位数字员工
        </span>
        <span className="ml-auto">{timeAgo(workflow.updatedAt)}</span>
      </div>

      {/* 卡片操作：悬停显示，直接提供调试 / 运行记录 / 更多 */}
      <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-lg bg-surface/85 p-0.5 opacity-0 shadow-[var(--c-shadow-sm)] backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={action(onDebug)}
          title="调试"
          className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-accent"
        >
          <Play className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={action(onHistory)}
          title="运行记录"
          className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
        >
          <History className="h-3.5 w-3.5" />
        </button>

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen((value) => !value);
            }}
            title="更多操作"
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>

          {menuOpen && (
            <div
              onClick={(event) => event.stopPropagation()}
              className="ui-glass-strong ui-ring absolute right-0 top-full z-30 mt-1 w-40 rounded-lg p-1"
            >
              <CardMenuItem icon={SquarePen} label="编辑" onClick={action(onOpen)} />
              <CardMenuItem
                icon={PenLine}
                label="重命名 / 说明"
                onClick={action(onRename)}
              />
              <CardMenuItem
                icon={Copy}
                label="复制工作流"
                onClick={action(onDuplicate)}
              />
              <div className="my-1 h-px bg-border" />
              <CardMenuItem
                icon={Trash2}
                label="删除工作流"
                danger
                onClick={action(onDelete)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CardMenuItem({
  icon: Icon,
  label,
  danger = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  danger?: boolean;
  onClick: (event: React.MouseEvent) => void;
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

// ============================================================================
// 空态
// ============================================================================

function NoWorkspaceState({
  creating,
  onCreate,
}: {
  creating: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-24 text-center text-text-muted">
      <div className="ui-btn-round flex h-16 w-16 items-center justify-center rounded-2xl">
        <Folder className="h-6 w-6" />
      </div>
      <h2 className="ui-serif text-heading font-semibold text-text-secondary">
        先创建一个工作区
      </h2>
      <p className="text-body leading-relaxed">
        工作区是一个根目录。工作流、运行产物和 Agent 的工作目录都会落在里面，
        选一个项目文件夹开始吧。
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
        创建第一个工作区
      </button>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-20 text-center text-text-muted">
      <div className="ui-btn-round flex h-16 w-16 items-center justify-center rounded-2xl">
        <WorkflowIcon className="h-6 w-6" />
      </div>
      <h2 className="ui-serif text-heading font-semibold text-text-secondary">
        把数字员工串成流水线
      </h2>
      <p className="text-body leading-relaxed">
        一个工作流由开始、数字员工节点和结束组成。在画布上连线，
        就能定义任务在团队之间的流转顺序。
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="ui-btn-primary mt-2 flex items-center gap-1.5 rounded-full px-4 py-2 text-body font-medium"
      >
        <Plus className="h-4 w-4" />
        新建工作流
      </button>
    </div>
  );
}
