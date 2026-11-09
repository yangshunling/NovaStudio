/**
 * 工作流编辑器
 *
 * 布局：
 * - 左侧上半：节点面板（开始 / 结束 / 节点），点击即加入画布
 * - 左侧下半：数字员工列表，点击即加入一个已绑定该员工的执行节点
 * - 右侧：可拖拽 / 缩放的画布；选中节点后在其右上角浮出配置面板
 *
 * 编辑中的图只存在组件状态里，点「保存」才写回 SQLite；
 * 离开前若有未保存修改会二次确认，避免静默丢失。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Bug,
  CircleStop,
  Flag,
  History,
  Info,
  LayoutGrid,
  Play,
  Plus,
  Redo2,
  RotateCw,
  Save,
  SkipForward,
  Trash2,
  Undo2,
  UserCheck,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { newId } from "../../lib/utils";
import { toast } from "../../stores/toast";
import { confirmDialog } from "../../stores/confirm";
import { EmployeeAvatar } from "../employees/EmployeeAvatar";
import { Button } from "../ui/Button";
import { Page } from "../ui/Page";
import { Select } from "../ui/Select";
import { WorkflowCanvas, WF_NODE_W } from "./WorkflowCanvas";
import { WorkflowDebugPanel } from "./WorkflowDebugPanel";
import { defaultNodeConfig } from "./defaults";
import {
  GraphValidationError,
  validateGraph,
} from "@shared/workflow-graph";
import type {
  DigitalEmployee,
  Project,
  Workflow,
  WorkflowEdge,
  WorkflowFailureStrategy,
  WorkflowNode,
  WorkflowNodeRunStatus,
  WorkflowNodeType,
  WorkflowReviewMode,
  WorkflowRunDetail,
  WorkflowRunStatus,
} from "@shared/types";

const INPUT_CLASS =
  "ui-ring w-full rounded-lg bg-input-bg px-3 py-2 text-body-lg text-text placeholder-text-muted outline-none transition-colors focus:border-input-border-focus";

/**
 * 数字小输入框：视觉与 INPUT_CLASS 一致，但**不含 w-full**。
 *
 * 若直接拼 `${INPUT_CLASS} w-16`，Tailwind 产物里 .w-full 排在 .w-16 之后，
 * 实际生效的是 w-full；再叠加 shrink-0 就会把输入框撑出父容器。
 */
const COMPACT_INPUT_CLASS =
  "ui-ring rounded-lg bg-input-bg px-3 py-2 text-center text-body-lg text-text outline-none transition-colors focus:border-input-border-focus";

const COL_W = 300;
const ROW_H = 160;

interface GraphSnapshot {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** 失败策略的文案与解释；执行引擎按同一套语义实现 */
const FAILURE_OPTIONS: ReadonlyArray<{
  value: WorkflowFailureStrategy;
  label: string;
  hint: string;
  icon: LucideIcon;
}> = [
  {
    value: "stop",
    label: "失败停止",
    hint: "节点失败后立即终止整个工作流。",
    icon: CircleStop,
  },
  {
    value: "skip",
    label: "自动跳过",
    hint: "节点失败后标记为跳过，继续执行下游节点。",
    icon: SkipForward,
  },
  {
    value: "retry",
    label: "自动重试",
    hint: "自动重试指定次数，仍然失败则终止工作流。",
    icon: RotateCw,
  },
];

/** 审核门禁的文案与解释 */
const REVIEW_OPTIONS: ReadonlyArray<{
  value: WorkflowReviewMode;
  label: string;
  hint: string;
  icon: LucideIcon;
}> = [
  {
    value: "auto",
    label: "自动通过",
    hint: "节点执行完成后直接视为通过，继续下游。",
    icon: Zap,
  },
  {
    value: "manual",
    label: "人工审核",
    hint: "节点执行完成后暂停，等人工确认产物。可要求修改（同一会话继续），驳回会立即终止整条运行。",
    icon: UserCheck,
  },
];

const LABEL_CLASS = "mb-1.5 block text-meta font-medium text-text-secondary";
const SECTION_TITLE_CLASS = "mb-2 text-body font-semibold text-text";

/** 从节点当前占位里找一个空槽，避免新增节点互相压住 */
function freePosition(nodes: WorkflowNode[]): { x: number; y: number } {
  for (let i = 0; i < 200; i++) {
    const position = {
      x: 120 + (i % 3) * COL_W,
      y: 140 + Math.floor(i / 3) * ROW_H,
    };
    const occupied = nodes.some(
      (node) =>
        Math.abs(node.position.x - position.x) < 40 &&
        Math.abs(node.position.y - position.y) < 40,
    );
    if (!occupied) return position;
  }
  return { x: 120, y: 140 };
}

interface WorkflowEditorProps {
  workflow: Workflow;
  /** 全部工作区：用于给「未归属」的历史工作流重新指定归属 */
  workspaces: Project[];
  employees: DigitalEmployee[];
  onBack: () => void;
  /** 保存后只更新列表、不退出编辑器 */
  onDraftSaved: (workflow: Workflow) => void;
  /** 打开该工作流的运行记录列表 */
  onOpenHistory: () => void;
  /** 打开本次运行详情（调试面板里的入口） */
  onOpenRunDetail?: (runId: string) => void;
  /** 从卡片直接点「调试」时，带着已启动的 runId 进入编辑器 */
  initialDebugRunId?: string | null;
}

export function WorkflowEditor({
  workflow,
  workspaces,
  employees,
  onBack,
  onDraftSaved,
  onOpenHistory,
  onOpenRunDetail,
  initialDebugRunId = null,
}: WorkflowEditorProps) {
  const [name, setName] = useState(workflow.name);
  /** 工作区归属可在编辑器里修改（主要服务「未归属」的历史工作流） */
  const [workspaceId, setWorkspaceId] = useState(workflow.workspaceId);
  const workspace =
    workspaces.find((item) => item.id === workspaceId) ?? null;
  const [nodes, setNodes] = useState<WorkflowNode[]>(workflow.graph.nodes);
  const [edges, setEdges] = useState<WorkflowEdge[]>(workflow.graph.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // === 画布历史（撤销 / 重做） ===
  const undoStack = useRef<GraphSnapshot[]>([]);
  const redoStack = useRef<GraphSnapshot[]>([]);
  const lastCommitted = useRef<GraphSnapshot>({ nodes, edges });
  const historyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipCommit = useRef(false);
  const [, setHistoryVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fitRequest, setFitRequest] = useState(0);

  /** 调试：直接在当前画布上展示状态，不跳转运行详情页 */
  const [debugRunId, setDebugRunId] = useState<string | null>(
    initialDebugRunId,
  );
  const [debugDetail, setDebugDetail] = useState<WorkflowRunDetail | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);
  /** 启动请求在途：防止双击触发两次 start（主进程会以“工作区忙”拒绝第二次） */
  const startingDebugRef = useRef(false);
  const previousDebugStatus = useRef<WorkflowRunStatus | null>(null);

  // 卡片上点「调试」时，run 已经在父级启动；这里接上它的实时状态
  useEffect(() => {
    if (initialDebugRunId) setDebugRunId(initialDebugRunId);
  }, [initialDebugRunId]);

  // 名称输入框按实际文字宽度伸缩，让「未保存」徽标紧贴名称
  const nameMeasureRef = useRef<HTMLSpanElement>(null);
  const [nameWidth, setNameWidth] = useState(() =>
    Math.min(384, Math.max(64, name.length * 16 + 2)),
  );

  useLayoutEffect(() => {
    const el = nameMeasureRef.current;
    if (!el) return;
    setNameWidth(
      Math.min(384, Math.max(64, Math.ceil(el.getBoundingClientRect().width) + 2)),
    );
  }, [name]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  /*
   * 与主进程共用同一套图校验：保存前就能看到问题，而不是等到点调试
   * 才收到一条会被很快关掉的 toast。
   */
  const validation = useMemo(() => {
    const employeeMap = new Map(
      employees.map((employee) => [employee.id, employee]),
    );
    try {
      const result = validateGraph({ nodes, edges }, employeeMap);
      return { issues: [] as string[], warnings: result.warnings };
    } catch (err) {
      if (err instanceof GraphValidationError) {
        return { issues: err.issues, warnings: err.warnings };
      }
      return {
        issues: [err instanceof Error ? err.message : String(err)],
        warnings: [] as string[],
      };
    }
  }, [nodes, edges, employees]);

  const canDebug = validation.issues.length === 0;

  /** 校验信息里带节点名的，直接标到画布节点上 */
  const nodeIssues = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const issue of validation.issues) {
      for (const node of nodes) {
        if (issue.includes(`「${node.name}」`)) {
          (map[node.id] ??= []).push(issue);
        }
      }
    }
    return map;
  }, [validation.issues, nodes]);

  const handleChange = useCallback(
    (nextNodes: WorkflowNode[], nextEdges: WorkflowEdge[]) => {
      setNodes(nextNodes);
      setEdges(nextEdges);
      setDirty(true);
    },
    [],
  );

  // 变更停止 350ms 后记一次历史，拖拽过程不会产生几十个撤销点
  useEffect(() => {
    if (skipCommit.current) {
      skipCommit.current = false;
      lastCommitted.current = { nodes, edges };
      return;
    }
    // 一旦产生新改动，之前的重做链立即失效
    if (redoStack.current.length > 0) {
      redoStack.current = [];
      setHistoryVersion((value) => value + 1);
    }
    if (historyTimer.current) clearTimeout(historyTimer.current);
    historyTimer.current = setTimeout(() => {
      const current = { nodes, edges };
      const last = lastCommitted.current;
      if (last.nodes === nodes && last.edges === edges) return;
      if (JSON.stringify(last) === JSON.stringify(current)) {
        lastCommitted.current = current;
        return;
      }
      undoStack.current.push(last);
      if (undoStack.current.length > 100) undoStack.current.shift();
      redoStack.current = [];
      lastCommitted.current = current;
      setHistoryVersion((value) => value + 1);
    }, 350);
    return () => {
      if (historyTimer.current) clearTimeout(historyTimer.current);
    };
  }, [nodes, edges]);

  const undo = useCallback(() => {
    if (historyTimer.current) {
      // 当前改动还没提交：撤销就是回到上一次已提交的快照，
      // 不能直接弹栈，否则会多退一步。
      clearTimeout(historyTimer.current);
      historyTimer.current = null;
      redoStack.current.push({ nodes, edges });
      skipCommit.current = true;
      setNodes(lastCommitted.current.nodes);
      setEdges(lastCommitted.current.edges);
      setDirty(true);
      setHistoryVersion((value) => value + 1);
      return;
    }
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push({ nodes, edges });
    skipCommit.current = true;
    setNodes(previous.nodes);
    setEdges(previous.edges);
    lastCommitted.current = previous;
    setDirty(true);
    setHistoryVersion((value) => value + 1);
  }, [nodes, edges]);

  const redo = useCallback(() => {
    // 有未提交改动时重做没有意义（新改动已经清空重做链）
    if (historyTimer.current) return;
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push({ nodes, edges });
    skipCommit.current = true;
    setNodes(next.nodes);
    setEdges(next.edges);
    lastCommitted.current = next;
    setDirty(true);
    setHistoryVersion((value) => value + 1);
  }, [nodes, edges]);

  /** 单击选中；Shift / Ctrl 追加选择 */
  const selectNode = useCallback(
    (id: string | null, additive = false) => {
      if (!id) {
        setSelectedNodeId(null);
        setSelectedNodeIds([]);
        return;
      }
      if (additive) {
        const exists = selectedNodeIds.includes(id);
        const next = exists
          ? selectedNodeIds.filter((item) => item !== id)
          : [...selectedNodeIds, id];
        setSelectedNodeIds(next);
        setSelectedNodeId(exists ? (next[next.length - 1] ?? null) : id);
        return;
      }
      setSelectedNodeId(id);
      setSelectedNodeIds([id]);
    },
    [selectedNodeIds],
  );

  // 节点被删除 / 撤销掉后，清掉已经不存在的选中项
  useEffect(() => {
    setSelectedNodeIds((current) => {
      const next = current.filter((id) => nodes.some((node) => node.id === id));
      return next.length === current.length ? current : next;
    });
    setSelectedNodeId((current) =>
      current && nodes.some((node) => node.id === current) ? current : null,
    );
  }, [nodes]);

  const addNode = (type: WorkflowNodeType, employee?: DigitalEmployee) => {
    const id = newId();
    const employeeCount = nodes.filter((n) => n.type === "employee").length;
    const node: WorkflowNode = {
      id,
      type,
      name:
        type === "start"
          ? "开始"
          : type === "end"
            ? "结束"
            : employee?.name ?? `节点 ${employeeCount + 1}`,
      position: freePosition(nodes),
      config: {
        ...defaultNodeConfig(),
        employeeId: employee?.id ?? null,
      },
    };
    setNodes((current) => [...current, node]);
    setSelectedNodeId(id);
    setSelectedNodeIds([id]);
    setSelectedEdgeId(null);
    setDirty(true);
  };

  const patchNode = (
    id: string,
    patch: Partial<Pick<WorkflowNode, "name">>,
    configPatch?: Partial<WorkflowNode["config"]>,
  ) => {
    setNodes((current) =>
      current.map((node) =>
        node.id === id
          ? { ...node, ...patch, config: { ...node.config, ...configPatch } }
          : node,
      ),
    );
    setDirty(true);
  };

  const deleteNode = (id: string) => {
    setNodes((current) => current.filter((node) => node.id !== id));
    setEdges((current) =>
      current.filter((edge) => edge.source !== id && edge.target !== id),
    );
    setSelectedNodeIds((current) => current.filter((item) => item !== id));
    setSelectedNodeId((current) => (current === id ? null : current));
    setDirty(true);
  };

  /** 按入度分层做一次从左到右的自动排版 */
  const autoLayout = () => {
    const incoming = new Map<string, number>();
    nodes.forEach((node) => incoming.set(node.id, 0));
    edges.forEach((edge) =>
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1),
    );

    const levels = new Map<string, number>();
    const queue = nodes
      .filter((node) => (incoming.get(node.id) ?? 0) === 0)
      .map((node) => node.id);
    queue.forEach((id) => levels.set(id, 0));

    let guard = 0;
    while (queue.length > 0 && guard++ < 2000) {
      const id = queue.shift()!;
      const level = levels.get(id) ?? 0;
      edges
        .filter((edge) => edge.source === id)
        .forEach((edge) => {
          const next = Math.max(level + 1, levels.get(edge.target) ?? 0);
          levels.set(edge.target, next);
          if (!queue.includes(edge.target)) queue.push(edge.target);
        });
    }

    const byLevel = new Map<number, string[]>();
    nodes.forEach((node) => {
      const level = levels.get(node.id) ?? 0;
      byLevel.set(level, [...(byLevel.get(level) ?? []), node.id]);
    });

    setNodes((current) =>
      current.map((node) => {
        const level = levels.get(node.id) ?? 0;
        const row = (byLevel.get(level) ?? []).indexOf(node.id);
        return {
          ...node,
          position: {
            x: 120 + level * (WF_NODE_W + 96),
            y: 140 + row * ROW_H,
          },
        };
      }),
    );
    setDirty(true);
    setFitRequest((value) => value + 1);
  };

  /** 写库但不决定是否退出编辑器；保存按钮与运行前自动保存共用 */
  const persist = useCallback(async (): Promise<Workflow | null> => {
    setSaving(true);
    setError(null);
    try {
      const updated = await ipc.updateWorkflow(workflow.id, {
        workspaceId,
        name: name.trim() || "未命名工作流",
        description: workflow.description,
        graph: { nodes, edges },
      });
      if (!updated) {
        setError("保存失败：工作流不存在");
        return null;
      }
      setDirty(false);
      return updated;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, [workflow.id, workspaceId, workflow.description, name, nodes, edges]);

  const save = useCallback(async () => {
    const updated = await persist();
    // 保存留在编辑器：用户通常要连续调整多个节点，不应每保存一次就退出
    if (updated) {
      onDraftSaved(updated);
      toast.success("工作流已保存");
    }
  }, [persist, onDraftSaved]);

  /** 重新进入编辑器时，如果该工作流还有活跃调试，直接把状态接回来 */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const runs = await ipc.listWorkflowRuns(workflow.id);
        const active = runs.find(
          (run) =>
            run.status === "running" ||
            run.status === "awaiting_approval",
        );
        if (alive && active) setDebugRunId(active.id);
      } catch (err) {
        // 读取失败不影响继续编辑，但要让用户知道没有自动接回调试
        console.warn("[workflow] 活跃运行恢复失败：", err);
        if (alive) toast.error("未能恢复调试状态，可稍后重新运行", 5000);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workflow.id]);

  // 调试事件 → 拉取最新运行详情（事件可能密集，做一次 80ms 合并）
  useEffect(() => {
    if (!debugRunId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let errorReported = false;

    const load = async () => {
      try {
        const next = await ipc.getWorkflowRun(debugRunId);
        if (!alive) return;
        setDebugDetail(next);
        errorReported = false;
        // 运行被删除后不能一直停在“调试中”
        if (!next) setDebugRunId(null);
      } catch (err) {
        // 单次读取失败不打断调试，但持续失败要让用户知道状态已过期
        console.warn("[workflow] 调试状态刷新失败：", err);
        if (alive && !errorReported) {
          errorReported = true;
          toast.error("调试状态刷新失败，正在显示上次结果", 5000);
        }
      }
    };

    void load();
    const off = ipc.on.workflowRunEvent((event) => {
      if (event.runId !== debugRunId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 80);
    });

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [debugRunId]);

  // 调试结束提示
  useEffect(() => {
    const status = debugDetail?.run.status;
    if (!status) return;
    const previous = previousDebugStatus.current;
    previousDebugStatus.current = status;
    if (!previous || previous === status) return;

    if (status === "succeeded") toast.success("调试完成");
    else if (status === "failed")
      toast.error(debugDetail?.run.error || "调试失败", 5000);
    else if (status === "canceled") toast.info("调试已取消");
    else if (status === "interrupted")
      toast.error(debugDetail?.run.error || "调试被中断", 5000);
  }, [debugDetail?.run.status, debugDetail?.run.error]);

  const nodeStates = useMemo(() => {
    const map: Record<string, WorkflowNodeRunStatus> = {};
    debugDetail?.nodes.forEach((node) => {
      map[node.nodeId] = node.status;
    });
    return map;
  }, [debugDetail]);

  const debugActive =
    debugRunId !== null &&
    (debugDetail
      ? debugDetail.run.status === "running" ||
        debugDetail.run.status === "awaiting_approval"
      : true);

  /** 调试：留在当前画布，实时显示节点状态 */
  const startDebug = async () => {
    if (!workspace) {
      toast.error("工作流未指定工作区，无法调试");
      return;
    }
    if (saving || debugActive || startingDebugRef.current) return;
    startingDebugRef.current = true;

    try {
      // 调试读取数据库里的最新版本：有改动先保存，但不退出编辑器
      if (dirty) {
        const updated = await persist();
        if (!updated) return;
        onDraftSaved(updated);
      }

      const run = await ipc.startWorkflowRun(workflow.id);
      previousDebugStatus.current = null;
      setDebugDetail(null);
      setDebugRunId(run.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(message, 6000);
    } finally {
      startingDebugRef.current = false;
    }
  };

  const decideDebug = async (
    nodeRunId: string,
    action: "approve" | "reject" | "revise",
    note: string,
  ) => {
    if (!debugRunId || debugBusy) return;

    setDebugBusy(true);
    try {
      const handled = await ipc.approveWorkflowNode(
        debugRunId,
        nodeRunId,
        action,
        note.trim() || undefined,
      );
      // 返回 false 说明这条审批已失效（运行结束或被别处处理），必须告诉用户
      if (!handled) {
        toast.error("该审核已失效：运行可能已结束或在别处处理过", 5000);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDebugBusy(false);
    }
  };

  const cancelDebug = async () => {
    if (!debugRunId || debugBusy) return;
    setDebugBusy(true);
    try {
      await ipc.cancelWorkflowRun(debugRunId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDebugBusy(false);
    }
  };

  const openDebugArtifacts = async () => {
    if (!debugRunId) return;
    const ok = await ipc.openWorkflowArtifacts(debugRunId);
    if (!ok) toast.error("无法打开产物目录");
  };

  /** 打开本次运行的完整详情；有未保存改动先落库，避免切页丢失 */
  const openRunDetail = async () => {
    if (!debugRunId) return;
    if (dirty) {
      const updated = await persist();
      if (!updated) return;
      onDraftSaved(updated);
    }
    onOpenRunDetail?.(debugRunId);
  };

  const closeDebug = () => {
    setDebugRunId(null);
    setDebugDetail(null);
    setDebugBusy(false);
    previousDebugStatus.current = null;
  };

  const back = async () => {
    if (dirty) {
      const confirmed = await confirmDialog({
        title: "有未保存的修改，确定退出编辑？",
        message: "未保存的修改会丢失。",
        confirmLabel: "退出编辑",
        cancelLabel: "继续编辑",
        tone: "danger",
      });
      if (!confirmed) return;
    }
    onBack();
  };

  /** 打开运行记录前先落库，避免切换页面丢失画布修改 */
  const openHistory = async () => {
    if (dirty) {
      const updated = await persist();
      if (!updated) return;
      onDraftSaved(updated);
    }
    onOpenHistory();
  };

  // Ctrl/Cmd + S 保存；Ctrl/Cmd + Z 撤销；Ctrl/Cmd + Shift + Z / Y 重做
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void save();
        return;
      }
      if (key === "z" || key === "y") {
        const tag = (document.activeElement?.tagName ?? "").toLowerCase();
        // 输入框里保留浏览器自己的文本撤销
        if (tag === "input" || tag === "textarea") return;
        event.preventDefault();
        if (key === "y" || event.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, undo, redo]);

  // 有未保存改动时拦截窗口关闭，避免直接丢画布
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  return (
    <Page>
        {/* 顶栏：返回 / 名称 / 保存 */}
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center gap-3 border-b border-border px-4">
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft className="h-4 w-4" />}
            onClick={back}
            title="返回工作流列表"
          >
            返回
          </Button>

          <span className="h-5 w-px shrink-0 bg-border" />

          {/* 名称与状态徽标成组，徽标紧跟名称，不随剩余空间漂移 */}
          <div className="relative flex min-w-0 shrink-0 items-center gap-2">
            {/* 用同字号的隐藏文本量出真实宽度；输入框再按这个宽度收缩 */}
            <span
              ref={nameMeasureRef}
              aria-hidden
              className="ui-serif pointer-events-none invisible absolute whitespace-pre text-title font-semibold tracking-wide"
            >
              {name || "未命名工作流"}
            </span>

            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setDirty(true);
              }}
              placeholder="未命名工作流"
              style={{ width: nameWidth }}
              className="ui-serif min-w-0 bg-transparent text-title font-semibold tracking-wide text-text outline-none placeholder:text-text-muted"
            />

            {dirty && (
              <span
                title="改动尚未保存，按 Ctrl/Cmd + S 保存"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 text-meta font-medium text-accent"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                未保存
              </span>
            )}
          </div>

          {workspaces.length > 0 ? (
            <Select
              value={
                workspaces.some((item) => item.id === workspaceId)
                  ? workspaceId
                  : ""
              }
              onChange={(next) => {
                setWorkspaceId(next);
                setDirty(true);
              }}
              title="工作区决定运行目录与产物位置；切换后对下一次运行生效"
              className="ui-ring h-8 shrink-0 rounded-lg bg-input-bg px-2.5 text-meta text-text transition-colors focus:border-input-border-focus"
              options={[
                { value: "", label: "未归属 · 选择工作区…" },
                ...workspaces.map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
              ]}
            />
          ) : (
            <span className="shrink-0 text-meta text-error">
              未归属 · 请先创建工作区
            </span>
          )}

          <div className="min-w-0 flex-1" />

          {error && (
            <span className="truncate text-meta text-error" title={error}>
              {error}
            </span>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 rounded-full"
            icon={<History className="h-4 w-4" />}
            onClick={() => void openHistory()}
            title="查看这个工作流的历史运行"
          >
            运行记录
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 rounded-full text-text-muted"
            icon={<Undo2 className="h-4 w-4" />}
            onClick={undo}
            disabled={undoStack.current.length === 0}
            title="撤销（Ctrl/Cmd + Z）"
            aria-label="撤销"
          />
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 rounded-full text-text-muted"
            icon={<Redo2 className="h-4 w-4" />}
            onClick={redo}
            disabled={redoStack.current.length === 0}
            title="重做（Ctrl/Cmd + Shift + Z）"
            aria-label="重做"
          />

          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 rounded-full"
            icon={<LayoutGrid className="h-4 w-4" />}
            onClick={autoLayout}
            title="按连线自动排列节点"
          >
            自动布局
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 rounded-full"
            loading={saving}
            icon={<Save className="h-4 w-4" />}
            onClick={() => void save()}
          >
            保存
          </Button>

          <Button
            variant="primary"
            size="sm"
            className="shrink-0 rounded-full"
            loading={debugActive}
            icon={<Bug className="h-4 w-4" />}
            onClick={() => void startDebug()}
            disabled={saving || !workspace || !canDebug}
            title={
              !canDebug
                ? `先修复 ${validation.issues.length} 个问题再调试`
                : workspace
                  ? `在当前工作流中调试（产物写入 ${workspace.cwd} 下的 .novastudio）`
                  : "工作流未指定工作区，无法调试"
            }
          >
            {debugActive ? "调试中" : "调试"}
          </Button>
        </header>

        <div className="relative flex min-h-0 flex-1">
          {/* 左侧：节点面板 + 数字员工 */}
          <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-[var(--c-panel-bg)]">
            <div className="p-4">
              <p className="mb-3 px-1 text-meta font-semibold tracking-wide text-text-muted">
                节点
              </p>
              <div className="space-y-2">
                <PaletteItem
                  icon={<Play className="h-4 w-4" />}
                  tone="text-success bg-success/10"
                  title="开始"
                  description="工作流入口"
                  onClick={() => addNode("start")}
                />
                <PaletteItem
                  icon={<Flag className="h-4 w-4" />}
                  tone="text-text-muted bg-surface-hover"
                  title="结束"
                  description="工作流出口"
                  onClick={() => addNode("end")}
                />
                <PaletteItem
                  icon={<Bot className="h-4 w-4" />}
                  tone="text-accent bg-accent-soft"
                  title="节点"
                  description="绑定数字员工执行任务"
                  onClick={() => addNode("employee")}
                />
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col border-t border-border">
              <div className="flex items-center justify-between px-4 pb-2 pt-4">
                <p className="text-meta font-semibold tracking-wide text-text-muted">
                  数字员工
                </p>
                <span className="rounded-full bg-surface-hover px-2 py-0.5 font-mono text-caption text-text-muted">
                  {employees.length}
                </span>
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4">
                {employees.length === 0 ? (
                  <p className="px-1.5 py-2 text-meta leading-relaxed text-text-muted">
                    还没有数字员工。先到左侧「数字员工」创建，再回来点击加入工作流。
                  </p>
                ) : (
                  employees.map((employee) => (
                    <button
                      key={employee.id}
                      type="button"
                      onClick={() => addNode("employee", employee)}
                      title={`添加「${employee.name}」节点`}
                      className="group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-surface-hover active:scale-[0.99]"
                    >
                      <EmployeeAvatar employee={employee} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-lg text-text">
                          {employee.name}
                        </span>
                        <span className="block truncate text-meta text-text-muted">
                          {employee.role || "未设置职位"}
                        </span>
                      </span>
                      <Plus className="h-4 w-4 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  ))
                )}
              </div>
            </div>
          </aside>

          {/* 右侧：调试状态栏 + 画布 + 节点配置浮层 */}
          <div className="relative flex min-w-0 flex-1 flex-col">
            <ValidationBanner
              issues={validation.issues}
              warnings={validation.warnings}
            />

            {debugDetail && (
              <WorkflowDebugPanel
                detail={debugDetail}
                busy={debugBusy}
                onApprove={(nodeRunId, action, note) =>
                  void decideDebug(nodeRunId, action, note)
                }
                onCancel={() => void cancelDebug()}
                onOpenArtifacts={() => void openDebugArtifacts()}
                onOpenRun={() => void openRunDetail()}
                onClose={closeDebug}
              />
            )}

            <div className="relative min-h-0 flex-1">
              <WorkflowCanvas
                nodes={nodes}
                edges={edges}
                employees={employees}
                selectedNodeId={selectedNodeId}
                selectedNodeIds={selectedNodeIds}
                selectedEdgeId={selectedEdgeId}
                onChange={handleChange}
                onSelectNode={(id, additive) => {
                  selectNode(id, additive);
                  if (id) setSelectedEdgeId(null);
                }}
                onSelectEdge={(id) => {
                  setSelectedEdgeId(id);
                  if (id) {
                    setSelectedNodeId(null);
                    setSelectedNodeIds([]);
                  }
                }}
                fitRequest={fitRequest}
                nodeStates={nodeStates}
                nodeIssues={nodeIssues}
              />

              {selectedNode && (
                <NodeInspector
                  node={selectedNode}
                  employees={employees}
                  onPatch={patchNode}
                  onDelete={deleteNode}
                  onClose={() => setSelectedNodeId(null)}
                />
              )}
            </div>
          </div>
        </div>
    </Page>
  );
}

// ============================================================================
// 左侧节点面板项
// ============================================================================

function PaletteItem({
  icon,
  tone,
  title,
  description,
  onClick,
}: {
  icon: ReactNode;
  tone: string;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl border border-border bg-surface-2/40 px-2.5 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:bg-surface-2 hover:shadow-[var(--c-shadow-sm)] active:translate-y-0 active:scale-[0.99]"
    >
      <span
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${tone}`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body-lg font-medium text-text">{title}</span>
        <span className="block truncate text-meta text-text-muted">
          {description}
        </span>
      </span>
      <Plus className="h-4 w-4 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

// ============================================================================
// 节点配置浮层
// ============================================================================

function NodeInspector({
  node,
  employees,
  onPatch,
  onDelete,
  onClose,
}: {
  node: WorkflowNode;
  employees: DigitalEmployee[];
  onPatch: (
    id: string,
    patch: Partial<Pick<WorkflowNode, "name">>,
    configPatch?: Partial<WorkflowNode["config"]>,
  ) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const employee = employees.find((item) => item.id === node.config.employeeId);
  const typeLabel =
    node.type === "start"
      ? "开始节点"
      : node.type === "end"
        ? "结束节点"
        : "数字员工节点";

  return (
    <aside
      // 浮层永远盖在画布之上；阻止指针事件外流，避免任何画布手势误触
      onPointerDown={(event) => event.stopPropagation()}
      style={{ maxHeight: "calc(100% - 32px)" }}
      className="ui-glass-strong ui-ring ui-panel-in absolute right-4 top-4 z-30 flex w-[340px] flex-col overflow-y-auto rounded-2xl p-4"
    >
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          {node.type === "start" ? (
            <Play className="h-4 w-4" />
          ) : node.type === "end" ? (
            <Flag className="h-4 w-4" />
          ) : (
            <Bot className="h-4 w-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-lg font-semibold text-text">
            {typeLabel}
          </p>
          <p className="truncate text-meta text-text-muted">
            {node.name || "未命名节点"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="收起"
          className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text active:scale-95"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <label className={LABEL_CLASS}>节点名称</label>
      <input
        value={node.name}
        onChange={(event) => onPatch(node.id, { name: event.target.value })}
        className={INPUT_CLASS}
      />

      {node.type === "employee" ? (
        <>
          <div className="mt-4 border-t border-border pt-4">
            <label className={LABEL_CLASS}>数字员工</label>
            <Select
              value={node.config.employeeId ?? ""}
              onChange={(next) =>
                onPatch(node.id, {}, { employeeId: next || null })
              }
              className={INPUT_CLASS}
              options={[
                { value: "", label: "选择数字员工…" },
                ...employees.map((item) => ({
                  value: item.id,
                  label: `${item.name}${item.role ? ` · ${item.role}` : ""}`,
                })),
              ]}
            />

            {!employee && (
              <p className="mt-2 rounded-lg bg-error-bg px-3 py-2 text-meta text-error">
                尚未绑定数字员工，该节点无法执行。
              </p>
            )}
          </div>

          <div className="mt-4 border-t border-border pt-4">
            <p className={SECTION_TITLE_CLASS}>任务详情</p>
            <textarea
              value={node.config.taskDetail}
              onChange={(event) =>
                onPatch(node.id, {}, { taskDetail: event.target.value })
              }
              rows={6}
              placeholder="输入该节点要执行的任务…"
              className={`${INPUT_CLASS} resize-none cursor-text leading-relaxed`}
            />
            <p className="mt-2 text-meta leading-relaxed text-text-muted">
              节点执行时会把任务详情交给所选数字员工。例如：基于上一步结论，梳理需要修改的文件。
            </p>
          </div>

          {/* 失败策略：节点失败后的走向 */}
          <div className="mt-4 border-t border-border pt-4">
            <p className={SECTION_TITLE_CLASS}>失败策略</p>
            <Segmented
              value={node.config.failureStrategy}
              options={FAILURE_OPTIONS}
              onChange={(value) =>
                onPatch(node.id, {}, { failureStrategy: value })
              }
            />
            <p className="mt-2 text-meta leading-relaxed text-text-muted">
              {
                FAILURE_OPTIONS.find(
                  (item) => item.value === node.config.failureStrategy,
                )?.hint
              }
            </p>

            {node.config.failureStrategy === "retry" && (
              <div className="mt-3 flex items-center justify-between rounded-lg bg-surface-hover/60 px-3 py-2">
                <label
                  htmlFor={`retries-${node.id}`}
                  className="text-meta text-text-secondary"
                >
                  最大重试次数
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    id={`retries-${node.id}`}
                    type="number"
                    min={1}
                    max={5}
                    value={node.config.maxRetries}
                    onChange={(event) => {
                      const next = Math.min(
                        5,
                        Math.max(1, Math.round(Number(event.target.value) || 1)),
                      );
                      onPatch(node.id, {}, { maxRetries: next });
                    }}
                    className={`${COMPACT_INPUT_CLASS} w-16 shrink-0`}
                  />
                  <span className="text-meta text-text-muted">次</span>
                </div>
              </div>
            )}
          </div>

          {/* 审核门禁：执行完成后是否需要人工确认产物 */}
          <div className="mt-4 border-t border-border pt-4">
            <p className={SECTION_TITLE_CLASS}>审核门禁</p>
            <Segmented
              value={node.config.reviewMode}
              options={REVIEW_OPTIONS}
              onChange={(value) => onPatch(node.id, {}, { reviewMode: value })}
            />
            <p className="mt-2 text-meta leading-relaxed text-text-muted">
              {
                REVIEW_OPTIONS.find(
                  (item) => item.value === node.config.reviewMode,
                )?.hint
              }
            </p>

            {node.config.reviewMode === "manual" && (
              <div className="mt-3 flex items-center justify-between rounded-lg bg-surface-hover/60 px-3 py-2">
                <label
                  htmlFor={`revisions-${node.id}`}
                  className="text-meta text-text-secondary"
                >
                  最大修改轮数
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    id={`revisions-${node.id}`}
                    type="number"
                    min={0}
                    max={3}
                    value={node.config.maxRevisions ?? 1}
                    onChange={(event) => {
                      const next = Math.min(
                        3,
                        Math.max(0, Math.round(Number(event.target.value) || 0)),
                      );
                      onPatch(node.id, {}, { maxRevisions: next });
                    }}
                    className={`${COMPACT_INPUT_CLASS} w-16 shrink-0`}
                  />
                  <span className="text-meta text-text-muted">轮</span>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <p className="mt-4 rounded-lg bg-surface-hover/60 px-3 py-2.5 text-meta leading-relaxed text-text-muted">
          该节点只标示流程起止，不参与执行。
        </p>
      )}

      <button
        type="button"
        onClick={() => onDelete(node.id)}
        className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-error/25 bg-error-bg px-3 py-2 text-body font-medium text-error transition-colors hover:bg-error/10 active:scale-[0.99]"
      >
        <Trash2 className="h-4 w-4" />
        删除节点
      </button>
    </aside>
  );
}

// ============================================================================
// 分段选择器（策略 / 门禁共用）
// ============================================================================

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; icon: LucideIcon }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="grid gap-1 rounded-xl bg-surface-hover p-1"
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-body font-medium transition-all active:scale-[0.98] ${
              active
                ? "bg-surface text-accent shadow-[var(--c-shadow-sm)]"
                : "text-text-muted hover:bg-surface/60 hover:text-text"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ============================================================================
// 校验提示条
// ============================================================================

function ValidationBanner({
  issues,
  warnings,
}: {
  issues: string[];
  warnings: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  if (issues.length === 0 && warnings.length === 0) return null;

  const hasErrors = issues.length > 0;
  return (
    <section
      className={`shrink-0 border-b border-border px-4 py-2 ${
        hasErrors ? "bg-error-bg" : "bg-surface-2/40"
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 text-left"
      >
        {hasErrors ? (
          <AlertTriangle className="h-4 w-4 shrink-0 text-error" />
        ) : (
          <Info className="h-4 w-4 shrink-0 text-text-muted" />
        )}
        <span
          className={`min-w-0 flex-1 truncate text-meta font-medium ${
            hasErrors ? "text-error" : "text-text-secondary"
          }`}
        >
          {hasErrors
            ? `有 ${issues.length} 个问题会阻止调试`
            : `有 ${warnings.length} 条配置提示`}
          {hasErrors && warnings.length > 0
            ? `，另有 ${warnings.length} 条提示`
            : ""}
        </span>
        <span className="shrink-0 text-caption text-text-muted">
          {expanded ? "收起" : "查看"}
        </span>
      </button>

      {expanded && (
        <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-9 text-meta leading-relaxed">
          {issues.map((issue, index) => (
            <li key={`issue-${index}`} className="text-error">
              {issue}
            </li>
          ))}
          {warnings.map((warning, index) => (
            <li key={`warning-${index}`} className="text-text-muted">
              {warning}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
