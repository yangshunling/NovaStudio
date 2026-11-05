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

import { useEffect, useMemo, useRef, useState } from "react";
import { MENU_WIDTH, MenuItem, MenuPanel, MenuSeparator } from "../ui/Menu";
import {
  Copy,
  Folder,
  FolderKanban,
  History,
  Loader2,
  PenLine,
  Play,
  Plus,
  SquarePen,
  Trash2,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { newId, timeAgo, toMessage } from "../../lib/utils";
import { useLoad } from "../../hooks/useLoad";
import { useChatStore } from "../../stores/chat";
import { useEmployeesStore } from "../../stores/employees";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import { Dialog, DialogActions } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, TextArea, TextInput } from "../ui/Field";
import {
  EmptyBlock,
  EmptyState,
  ErrorState,
  FilterEmpty,
  LoadingState,
} from "../ui/EmptyState";
import { Page, PageHeader } from "../ui/Page";
import { SearchInput } from "../ui/SearchInput";
import { ListItem, ListPane } from "../ui/ListPane";
import {
  CARD_DESCRIPTION,
  CARD_FOOTER,
  CARD_ICON_TILE,
  CARD_SHELL,
  CARD_TITLE,
} from "../ui/cardStyles";
import { NoWorkspaceState } from "../ui/NoWorkspaceState";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowRunView } from "./WorkflowRunView";
import { WorkflowRunHistoryView } from "./WorkflowRunHistoryView";
import { defaultNodeConfig } from "./defaults";
import { RUN_STATUS } from "../../lib/workflow/status";
import { describeTriggerSchedule } from "@shared/trigger-schedule";
import type {
  Project,
  Workflow,
  WorkflowGraph,
  WorkflowRun,
  WorkflowTrigger,
  WorkflowTriggerBinding,
} from "@shared/types";

/** 未归属分组的伪工作区 id；真实工作区 id 都是 uuid，不会冲突 */
const ORPHAN_ID = "__orphan__";

/** 右键菜单尺寸：用于贴近视口边缘时收拢位置 */
const WORKFLOW_MENU_HEIGHT = 340;

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
  // 工作区列表复用 chat store（与工作区页、会话绑定共用同一份）
  const workspaces = useChatStore((s) => s.projects);
  const loadProjects = useChatStore((s) => s.loadProjects);
  const employees = useEmployeesStore((s) => s.employees);
  const loadEmployees = useEmployeesStore((s) => s.load);

  // 工作流 + 触发器绑定：一次拉齐，绑定关系用于卡片上的触发器数量标记
  const { data, loading, error, reload, setData } = useLoad(
    async () => {
      const [workflows, triggerBindings] = await Promise.all([
        ipc.listWorkflows(),
        ipc.listTriggerBindings(),
      ]);
      return { workflows, triggerBindings };
    },
    {
      workflows: [] as Workflow[],
      triggerBindings: [] as WorkflowTriggerBinding[],
    },
  );
  const { workflows, triggerBindings } = data;
  const setWorkflows = (
    next: Workflow[] | ((prev: Workflow[]) => Workflow[]),
  ) => setData((prev) => ({
    ...prev,
    workflows: typeof next === "function" ? next(prev.workflows) : next,
  }));
  const setTriggerBindings = (
    next: WorkflowTriggerBinding[] | ((prev: WorkflowTriggerBinding[]) => WorkflowTriggerBinding[]),
  ) => setData((prev) => ({
    ...prev,
    triggerBindings: typeof next === "function" ? next(prev.triggerBindings) : next,
  }));

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

  /** 正在配置触发器的工作流；null 表示弹框关闭 */
  const [triggerTarget, setTriggerTarget] = useState<Workflow | null>(null);
  const [allTriggers, setAllTriggers] = useState<WorkflowTrigger[]>([]);
  const [selectedTriggerIds, setSelectedTriggerIds] = useState<string[]>([]);
  const [triggerDialogLoading, setTriggerDialogLoading] = useState(false);
  const [triggerSaving, setTriggerSaving] = useState(false);

  /** 当前工作区的运行记录：卡片用它展示运行中 / 最近一次结果 */
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [runsRefresh, setRunsRefresh] = useState(0);
  const runsRef = useRef<WorkflowRun[]>([]);
  runsRef.current = runs;

  const [creatingWorkflow, setCreatingWorkflow] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [busy, setBusy] = useState(false);
  /** 运行记录列表的作用域：工作流级或工作区级 */
  const [historyScope, setHistoryScope] = useState<
    { workflowId: string } | { workspaceId: string } | null
  >(null);

  /** 右键菜单：工作流卡片使用，同一时间只开一个 */
  const [contextMenu, setContextMenu] = useState<
    { workflow: Workflow; x: number; y: number } | null
  >(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 右键菜单：外部点击 / Esc / 滚动 / 窗口缩放时关闭
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onDown = (event: MouseEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) close();
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
  }, [contextMenu]);

  /** 把菜单坐标收拢在视口内 */
  const menuPosition = (event: React.MouseEvent, height: number) => ({
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
  });

  const openWorkflowMenu = (workflow: Workflow, event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({
      workflow,
      ...menuPosition(event, WORKFLOW_MENU_HEIGHT),
    });
  };

  /** 首次骨架：等工作区 / 员工也加载完再展示，避免列表先空后跳 */
  const [storesReady, setStoresReady] = useState(false);

  /** 兼容旧调用点：刷新主数据 */
  const load = reload;

  // 工作区 / 员工由各自 store 提供（已加载则不重复拉取）
  useEffect(() => {
    void Promise.all([loadProjects(), loadEmployees()])
      .catch(() => {
        // 各自失败由 store 内部处理
      })
      .finally(() => setStoresReady(true));
  }, [loadProjects, loadEmployees]);

  // 列表变化后校正选中的工作区：被删则回退到第一个
  useEffect(() => {
    setSelectedWorkspaceId((current) =>
      current && workspaces.some((item) => item.id === current)
        ? current
        : (workspaces[0]?.id ?? null),
    );
  }, [workspaces]);

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

  /** workflowId → 已绑定的触发器数量 */
  const triggerCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const binding of triggerBindings) {
      map.set(binding.workflowId, (map.get(binding.workflowId) ?? 0) + 1);
    }
    return map;
  }, [triggerBindings]);

  // 工作区切换 / 运行事件 → 拉取该工作区的运行记录；有活跃运行时轮询兜底
  useEffect(() => {
    if (!effectiveWorkspaceId || effectiveWorkspaceId === ORPHAN_ID) {
      setRuns([]);
      return;
    }
    let alive = true;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const list = await ipc.listWorkspaceRuns(effectiveWorkspaceId);
        if (alive) setRuns(list);
      } catch {
        // 卡片状态不是核心路径，读取失败时保持上一次快照
      }
    };

    void load();
    const off = ipc.on.workflowRunEvent(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void load(), 200);
    });
    const timer = setInterval(() => {
      if (
        runsRef.current.some(
          (run) =>
            run.status === "running" || run.status === "awaiting_approval",
        )
      ) {
        void load();
      }
    }, 2500);

    return () => {
      alive = false;
      if (debounce) clearTimeout(debounce);
      clearInterval(timer);
      off();
    };
  }, [effectiveWorkspaceId, runsRefresh]);

  /** workflowId → 最近一次运行；活跃运行优先于更新的已结束运行 */
  const latestRunByWorkflow = useMemo(() => {
    const map = new Map<string, WorkflowRun>();
    const isActive = (run: WorkflowRun) =>
      run.status === "running" || run.status === "awaiting_approval";
    for (const run of runs) {
      const current = map.get(run.workflowId);
      if (!current) {
        map.set(run.workflowId, run);
        continue;
      }
      if (isActive(run) && !isActive(current)) {
        map.set(run.workflowId, run);
        continue;
      }
      if (!isActive(run) && isActive(current)) continue;
      if (run.createdAt > current.createdAt) map.set(run.workflowId, run);
    }
    return map;
  }, [runs]);

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

  /** 工作区的新增 / 删除统一在「工作区」页面完成 */
  const manageWorkspaces = () => useChatStore.getState().setViewMode("workspaces");

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
    } catch (err) {
      const message = toMessage(err);
      toast.error(`创建工作流失败：${message}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteWorkflow = async (workflow: Workflow) => {
    const confirmed = await confirmDialog({
      title: `删除工作流「${workflow.name}」？`,
      message: [
        "将同时删除它的运行记录、节点会话与 .novastudio 产物。",
        "此操作不可恢复。",
      ].join("\n"),
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await ipc.deleteWorkflow(workflow.id);
      setWorkflows((current) => current.filter((item) => item.id !== workflow.id));
      setRunsRefresh((value) => value + 1);
      if (editingId === workflow.id) setEditingId(null);
    } catch (err) {
      toast.error(toMessage(err));
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
      toast.error(toMessage(err), 6000);
    }
  };

  /** 卡片操作：选择该工作流由哪些触发器定时启动 */
  const openTriggerDialog = async (workflow: Workflow) => {
    setTriggerTarget(workflow);
    setTriggerDialogLoading(true);
    setSelectedTriggerIds([]);
    try {
      const [list, ids] = await Promise.all([
        ipc.listTriggers(),
        ipc.listWorkflowTriggerIds(workflow.id),
      ]);
      setAllTriggers(list);
      setSelectedTriggerIds(ids);
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setTriggerDialogLoading(false);
    }
  };

  const toggleTriggerSelection = (triggerId: string) => {
    setSelectedTriggerIds((current) =>
      current.includes(triggerId)
        ? current.filter((id) => id !== triggerId)
        : [...current, triggerId],
    );
  };

  const saveWorkflowTriggers = async () => {
    if (!triggerTarget || triggerSaving) return;
    setTriggerSaving(true);
    try {
      await ipc.setWorkflowTriggers(triggerTarget.id, selectedTriggerIds);
      setTriggerBindings(await ipc.listTriggerBindings());
      toast.success(
        selectedTriggerIds.length > 0
          ? `已绑定 ${selectedTriggerIds.length} 个触发器`
          : "已取消全部触发器",
      );
      setTriggerTarget(null);
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setTriggerSaving(false);
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
      toast.error(toMessage(err));
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
      toast.error(toMessage(err));
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
          setRunsRefresh((value) => value + 1);
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
          // 删除 / 重跑后卡片状态需要刷新
          setRunsRefresh((value) => value + 1);
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
        onDraftSaved={(updated) => {
          setWorkflows((current) =>
            current.map((item) => (item.id === updated.id ? updated : item)),
          );
        }}
        onOpenHistory={() => setHistoryScope({ workflowId: editing.id })}
        onOpenRunDetail={(runId) =>
          setRunning({ runId, workflowId: editing.id })
        }
      />
    );
  }

  return (
    <Page>
        {loading || !storesReady ? (
          <LoadingState text="正在加载工作区" className="h-full" />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : workspaceOptions.length === 0 ? (
          <NoWorkspaceState
            description="工作区是一个根目录。工作流、运行产物和 Agent 的工作目录都会落在里面。工作区统一在「工作区」页面登记，这里直接选用即可。"
            onManage={manageWorkspaces}
          />
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* 左：工作区列表 */}
            <ListPane
              title="工作区"
              action={
                <button
                  type="button"
                  onClick={manageWorkspaces}
                  title="管理工作区（新增 / 删除）"
                  aria-label="管理工作区"
                  className="ui-btn-round ui-icon-action flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors active:scale-95"
                >
                  <FolderKanban className="h-4 w-4" />
                </button>
              }
            >
              {workspaceOptions.map((workspace) => {
                const active = workspace.id === effectiveWorkspaceId;
                const isOrphan = workspace.id === ORPHAN_ID;
                const count = isOrphan
                  ? orphanWorkflows.length
                  : (counts.get(workspace.id) ?? 0);

                return (
                  <ListItem
                    key={workspace.id}
                    active={active}
                    icon={<Folder className="h-4 w-4" />}
                    title={workspace.name}
                    subtitle={
                      isOrphan ? "旧数据，待归入工作区" : workspace.cwd
                    }
                    monoSubtitle
                    titleAttr={workspace.cwd}
                    onClick={() => selectWorkspace(workspace.id)}
                    trailing={
                      <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 font-mono text-caption text-text-muted">
                        {count}
                      </span>
                    }
                  />
                );
              })}
            </ListPane>

            {/* 右：当前工作区的工作流 */}
            <div className="flex min-w-0 flex-1 flex-col">
              <PageHeader
                title={selectedWorkspace?.name ?? "工作流"}
                count={selectedWorkflows.length}
                countSuffix=" 个"
                icon={<WorkflowIcon className="h-4 w-4" />}
                subtitle={
                  selectedWorkspace && selectedWorkspace.id !== ORPHAN_ID
                    ? selectedWorkspace.cwd
                    : undefined
                }
                actions={
                  <>
                    <Button
                      onClick={() =>
                        effectiveWorkspaceId &&
                        effectiveWorkspaceId !== ORPHAN_ID &&
                        setHistoryScope({ workspaceId: effectiveWorkspaceId })
                      }
                      disabled={
                        !selectedWorkspace || selectedWorkspace.id === ORPHAN_ID
                      }
                      title="查看该工作区的运行记录"
                      icon={<History className="h-4 w-4" />}
                    >
                      运行记录
                    </Button>

                    <SearchInput
                      value={query}
                      onChange={setQuery}
                      placeholder="搜索名称 / 说明"
                    />

                    <Button
                      variant="primary"
                      onClick={openCreateWorkflow}
                      disabled={
                        !selectedWorkspace || selectedWorkspace.id === ORPHAN_ID
                      }
                      icon={<Plus className="h-4 w-4" />}
                    >
                      新建工作流
                    </Button>
                  </>
                }
              />

              <div className="min-h-0 flex-1 overflow-y-auto p-section">
                {selectedWorkspace?.id === ORPHAN_ID ? (
                  <EmptyState
                    icon={<Folder />}
                    title="工作流还没有归属工作区"
                    description="这些工作流创建于「工作区」功能之前。请先到「工作区」页面登记目录，再把它们重新归入。"
                    action={
                      <Button
                        variant="primary"
                        size="sm"
                        icon={<FolderKanban className="h-4 w-4" />}
                        onClick={manageWorkspaces}
                      >
                        去管理工作区
                      </Button>
                    }
                  />
                ) : selectedWorkflows.length === 0 ? (
                  <EmptyWorkflows onCreate={openCreateWorkflow} />
                ) : filtered.length === 0 ? (
                  <FilterEmpty
                    title={`没有匹配「${query}」的工作流`}
                    onClear={() => setQuery("")}
                  />
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                    {filtered.map((workflow) => (
                      <WorkflowCard
                        key={workflow.id}
                        workflow={workflow}
                        triggerCount={triggerCounts.get(workflow.id) ?? 0}
                        latestRun={latestRunByWorkflow.get(workflow.id) ?? null}
                        onOpen={() => openEditor(workflow)}
                        onRun={() => void debugWorkflow(workflow)}
                        onOpenRun={(runId) =>
                          setRunning({ runId, workflowId: workflow.id })
                        }
                        onContextMenu={(event) =>
                          openWorkflowMenu(workflow, event)
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

      <Dialog
        open={creatingWorkflow}
        onClose={() => setCreatingWorkflow(false)}
        title="新建工作流"
        width="sm"
        description={`将在工作区「${selectedWorkspace?.name}」下创建。创建后进入画布，从左侧点击节点或数字员工，把它们连成一条流水线。`}
      >
        <div className="space-y-3">
          <Field label="名称" required>
            <TextInput
              autoFocus
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createWorkflow();
              }}
              placeholder="例如：需求分析到代码修改"
            />
          </Field>

          <Field label="说明（可选）">
            <TextArea
              value={newDescription}
              onChange={(event) => setNewDescription(event.target.value)}
              rows={2}
              placeholder="这条流水线解决什么问题"
              className="resize-none"
            />
          </Field>
        </div>

        <DialogActions>
          <Button onClick={() => setCreatingWorkflow(false)}>取消</Button>
          <Button
            variant="primary"
            onClick={() => void createWorkflow()}
            disabled={!newName.trim()}
            loading={busy}
          >
            创建
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="编辑工作流信息"
        width="sm"
      >
        <div className="space-y-3">
          <Field label="名称" required>
            <TextInput
              autoFocus
              value={renameName}
              onChange={(event) => setRenameName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveRename();
              }}
            />
          </Field>

          <Field label="说明（可选）">
            <TextArea
              value={renameDescription}
              onChange={(event) => setRenameDescription(event.target.value)}
              rows={3}
              placeholder="这条流水线解决什么问题"
              className="resize-none"
            />
          </Field>
        </div>

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

      {/* 工作流 → 绑定触发器 */}
      <Dialog
        open={triggerTarget !== null}
        onClose={() => setTriggerTarget(null)}
        title={triggerTarget ? `触发器 · ${triggerTarget.name}` : "触发器"}
        width="md"
        description="勾选后，触发器到点会自动启动这条工作流。触发器可在左侧「触发器」页面统一创建与编辑，一个触发器也可以绑定多条工作流。"
      >
          {triggerDialogLoading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-body text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载触发器
            </div>
          ) : allTriggers.length === 0 ? (
            <EmptyBlock
              icon={<Zap />}
              title="还没有触发器"
              description="先创建一个定时规则，再回来把它绑定到这条工作流。"
              action={
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Plus className="h-3.5 w-3.5" />}
                  onClick={() => {
                    setTriggerTarget(null);
                    useChatStore.getState().setViewMode("triggers");
                  }}
                >
                  去创建触发器
                </Button>
              }
            />
          ) : (
            <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-0.5">
              {allTriggers.map((trigger) => {
                const selected = selectedTriggerIds.includes(trigger.id);
                return (
                  <label
                    key={trigger.id}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
                      selected
                        ? "border-accent/50 bg-accent-soft/40"
                        : "border-border bg-surface-2/40 hover:bg-surface-hover"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleTriggerSelection(trigger.id)}
                      className="mt-0.5 h-4 w-4 shrink-0"
                      style={{ accentColor: "var(--c-accent)" }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-body font-medium text-text">
                          {trigger.title}
                        </span>
                        {!trigger.enabled && (
                          <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-meta text-text-muted">
                            已停用
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-meta text-text-muted">
                        {describeTriggerSchedule(trigger.schedule)}
                        {trigger.description ? ` · ${trigger.description}` : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          <DialogActions>
            <Button onClick={() => setTriggerTarget(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={() => void saveWorkflowTriggers()}
              disabled={triggerDialogLoading}
              loading={triggerSaving}
            >
              保存
            </Button>
          </DialogActions>
      </Dialog>

      {/* 右键菜单：工作区 / 工作流卡片共用 */}
      {contextMenu && (
        <MenuPanel
          x={contextMenu.x}
          y={contextMenu.y}
          menuRef={contextMenuRef}
        >
          <MenuItem
            icon={SquarePen}
            label="编辑"
            onClick={() => {
              const workflow = contextMenu.workflow;
              setContextMenu(null);
              openEditor(workflow);
            }}
          />
          <MenuItem
            icon={Play}
            label="运行"
            onClick={() => {
              const workflow = contextMenu.workflow;
              setContextMenu(null);
              void debugWorkflow(workflow);
            }}
          />
          <MenuItem
            icon={Zap}
            label="触发器"
            onClick={() => {
              const workflow = contextMenu.workflow;
              setContextMenu(null);
              void openTriggerDialog(workflow);
            }}
          />
          <MenuItem
            icon={History}
            label="运行记录"
            onClick={() => {
              const workflow = contextMenu.workflow;
              setContextMenu(null);
              setHistoryScope({ workflowId: workflow.id });
            }}
          />
          <MenuItem
            icon={PenLine}
            label="重命名 / 说明"
            onClick={() => {
              const workflow = contextMenu.workflow;
              setContextMenu(null);
              openRename(workflow);
            }}
          />
          <MenuItem
            icon={Copy}
            label="复制工作流"
            onClick={() => {
              const workflow = contextMenu.workflow;
              setContextMenu(null);
              void duplicateWorkflow(workflow);
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={Trash2}
            label="删除工作流"
            danger
            onClick={() => {
              const workflow = contextMenu.workflow;
              setContextMenu(null);
              void deleteWorkflow(workflow);
            }}
          />
        </MenuPanel>
      )}
    </Page>
  );
}

// ============================================================================
// 工作流卡片
// ============================================================================

function WorkflowCard({
  workflow,
  triggerCount,
  latestRun,
  onOpen,
  onRun,
  onOpenRun,
  onContextMenu,
}: {
  workflow: Workflow;
  triggerCount: number;
  latestRun: WorkflowRun | null;
  onOpen: () => void;
  onRun: () => void;
  onOpenRun: (runId: string) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const nodeCount = workflow.graph.nodes.length;
  const employeeIds = new Set(
    workflow.graph.nodes
      .filter((node) => node.type === "employee" && node.config.employeeId)
      .map((node) => node.config.employeeId),
  );
  const active =
    latestRun?.status === "running" ||
    latestRun?.status === "awaiting_approval";
  const runMeta = latestRun ? RUN_STATUS[latestRun.status] : null;
  const RunIcon = runMeta?.icon;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        // 只响应卡片本身，不拦截内部操作按钮的键盘事件
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`${CARD_SHELL} cursor-pointer`}
    >
      <div className="flex items-start gap-3">
        <span className={CARD_ICON_TILE}>
          <WorkflowIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className={CARD_TITLE}>{workflow.name}</h3>
          <p className={`mt-2 ${CARD_DESCRIPTION}`}>
            {workflow.description || "暂无说明"}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-meta text-text-muted">
        {runMeta && RunIcon && (
          <span
            className={`flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 ${runMeta.className}`}
          >
            <RunIcon className={`h-3 w-3 ${active ? "animate-spin" : ""}`} />
            {runMeta.label}
          </span>
        )}
        <span className="rounded-full bg-surface-hover px-2 py-0.5">
          {nodeCount} 个节点
        </span>
        <span className="rounded-full bg-surface-hover px-2 py-0.5">
          {employeeIds.size} 位数字员工
        </span>
        {triggerCount > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-accent">
            <Zap className="h-3 w-3" />
            {triggerCount} 个触发器
          </span>
        )}
      </div>

      <div className={CARD_FOOTER}>
        <span className="min-w-0 truncate text-meta text-text-muted">
          {latestRun
            ? `${active ? "本次运行" : "最近运行"} ${timeAgo(latestRun.createdAt)}`
            : "尚未运行"}
        </span>
        <Button
          variant="primary"
          size="xs"
          onClick={(event) => {
            event.stopPropagation();
            if (active && latestRun) onOpenRun(latestRun.id);
            else onRun();
          }}
          icon={
            active ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )
          }
        >
          {latestRun?.status === "awaiting_approval"
            ? "去审核"
            : active
              ? "查看运行"
              : "运行"}
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// 空态
// ============================================================================

function EmptyWorkflows({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      icon={<WorkflowIcon />}
      title="把数字员工串成流水线"
      description="一个工作流由开始、数字员工节点和结束组成。在画布上连线，就能定义任务在团队之间的流转顺序。"
      action={
        <Button
          variant="primary"
          onClick={onCreate}
          icon={<Plus className="h-4 w-4" />}
        >
          新建工作流
        </Button>
      }
    />
  );
}
