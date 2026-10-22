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
  ArrowLeft,
  Bot,
  CircleStop,
  Flag,
  LayoutGrid,
  Loader2,
  Play,
  Plus,
  RotateCw,
  Save,
  SkipForward,
  Trash2,
  UserCheck,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { newId } from "../../lib/utils";
import { SkinStage } from "../SkinStage";
import { EmployeeAvatar } from "../employees/EmployeeAvatar";
import { WorkflowCanvas, WF_NODE_W } from "./WorkflowCanvas";
import { defaultNodeConfig } from "./defaults";
import type {
  DigitalEmployee,
  Workflow,
  WorkflowEdge,
  WorkflowFailureStrategy,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowReviewMode,
} from "@shared/types";

const INPUT_CLASS =
  "ui-ring w-full rounded-lg bg-input-bg px-3 py-2 text-body-lg text-text placeholder-text-muted outline-none transition-colors focus:border-input-border-focus";

const COL_W = 300;
const ROW_H = 160;

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
    hint: "节点执行前无需确认，直接运行。",
    icon: Zap,
  },
  {
    value: "manual",
    label: "人工审核",
    hint: "执行前暂停等待人工处理；驳回按失败策略处理。",
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
  employees: DigitalEmployee[];
  onBack: () => void;
  /** 保存成功后回传最新工作流，供列表更新 */
  onSaved: (workflow: Workflow) => void;
}

export function WorkflowEditor({
  workflow,
  employees,
  onBack,
  onSaved,
}: WorkflowEditorProps) {
  const [name, setName] = useState(workflow.name);
  const [nodes, setNodes] = useState<WorkflowNode[]>(workflow.graph.nodes);
  const [edges, setEdges] = useState<WorkflowEdge[]>(workflow.graph.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fitRequest, setFitRequest] = useState(0);

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

  const handleChange = useCallback(
    (nextNodes: WorkflowNode[], nextEdges: WorkflowEdge[]) => {
      setNodes(nextNodes);
      setEdges(nextEdges);
      setDirty(true);
    },
    [],
  );

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
    setSelectedNodeId(null);
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

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await ipc.updateWorkflow(workflow.id, {
        name: name.trim() || "未命名工作流",
        description: workflow.description,
        graph: { nodes, edges },
      });
      if (!updated) {
        setError("保存失败：工作流不存在");
        return;
      }
      setDirty(false);
      // 保存成功即退出编辑：由父级负责刷新列表并弹出 toast
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [workflow.id, workflow.description, name, nodes, edges, onSaved]);

  const back = () => {
    if (dirty && !window.confirm("有未保存的修改，确定退出编辑？")) return;
    onBack();
  };

  // Ctrl/Cmd + S 保存
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <SkinStage />

      <div className="ui-page relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
        {/* 顶栏：返回 / 名称 / 保存 */}
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center gap-3 border-b border-border px-4">
          <button
            type="button"
            onClick={back}
            title="返回工作流列表"
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-body text-text-muted transition-colors hover:bg-surface-hover hover:text-text active:scale-95"
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </button>

          <span className="h-5 w-px shrink-0 bg-border" />

          {/* 名称与状态徽标成组，徽标紧跟名称，不随剩余空间漂移 */}
          <div className="relative flex min-w-0 shrink-0 items-center gap-2">
            {/* 用同字号的隐藏文本量出真实宽度；输入框再按这个宽度收缩 */}
            <span
              ref={nameMeasureRef}
              aria-hidden
              className="pointer-events-none invisible absolute whitespace-pre text-heading font-semibold"
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
              className="min-w-0 bg-transparent text-heading font-semibold text-text outline-none placeholder:text-text-muted"
            />

            {dirty && (
              <span
                title="改动尚未保存，按 Ctrl/Cmd + S 保存"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent/30 bg-accent-soft px-2.5 py-1 text-meta font-medium text-accent"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                未保存
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1" />

          {error && (
            <span className="truncate text-meta text-error" title={error}>
              {error}
            </span>
          )}

          <button
            type="button"
            onClick={autoLayout}
            title="按连线自动排列节点"
            className="ui-btn-ghost flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95"
          >
            <LayoutGrid className="h-4 w-4" />
            自动布局
          </button>

          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="ui-btn-primary flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            保存
          </button>
        </header>

        <div className="relative flex min-h-0 flex-1">
          {/* 左侧：节点面板 + 数字员工 */}
          <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface-2/25">
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

          {/* 右侧：画布 + 节点配置浮层 */}
          <div className="relative min-w-0 flex-1">
            <WorkflowCanvas
              nodes={nodes}
              edges={edges}
              employees={employees}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onChange={handleChange}
              onSelectNode={(id) => {
                setSelectedNodeId(id);
                if (id) setSelectedEdgeId(null);
              }}
              onSelectEdge={(id) => {
                setSelectedEdgeId(id);
                if (id) setSelectedNodeId(null);
              }}
              fitRequest={fitRequest}
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
    </main>
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
      className="group flex w-full items-center gap-3 rounded-xl border border-border bg-surface-2/60 px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:bg-surface-2 hover:shadow-[var(--c-shadow-sm)] active:translate-y-0 active:scale-[0.99]"
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
        className={`${INPUT_CLASS} mb-4`}
      />

      {node.type === "employee" ? (
        <>
          <label className={LABEL_CLASS}>数字员工</label>
          <select
            value={node.config.employeeId ?? ""}
            onChange={(event) =>
              onPatch(node.id, {}, { employeeId: event.target.value || null })
            }
            className={`${INPUT_CLASS} mb-2`}
          >
            <option value="">选择数字员工…</option>
            {employees.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.role ? ` · ${item.role}` : ""}
              </option>
            ))}
          </select>

          {employee ? (
            <div className="flex items-center gap-3 rounded-xl bg-surface-hover/60 px-3 py-2.5">
              <EmployeeAvatar employee={employee} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body text-text">{employee.name}</p>
                <p className="truncate text-meta text-text-muted">
                  {employee.role || "未设置职位"}
                </p>
              </div>
            </div>
          ) : (
            <p className="rounded-lg bg-error-bg px-3 py-2 text-meta text-error">
              尚未绑定数字员工，该节点无法执行。
            </p>
          )}

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
                    className={`${INPUT_CLASS} w-16 shrink-0 text-center`}
                  />
                  <span className="text-meta text-text-muted">次</span>
                </div>
              </div>
            )}
          </div>

          {/* 审核门禁：执行前是否需要人工确认 */}
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
          </div>
        </>
      ) : (
        <p className="rounded-lg bg-surface-hover/60 px-3 py-2.5 text-meta leading-relaxed text-text-muted">
          该节点只标示流程起止，不参与执行。
        </p>
      )}

      <button
        type="button"
        onClick={() => onDelete(node.id)}
        className="mt-4 flex h-9 items-center justify-center gap-2 rounded-lg border border-border text-body font-medium text-error transition-colors hover:bg-error-bg active:scale-[0.99]"
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
