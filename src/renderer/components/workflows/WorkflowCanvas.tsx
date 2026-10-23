/**
 * 工作流画布
 *
 * 自绘的极简流程编辑器，不引入第三方图库：
 * - 拖拽节点移动，拖拽空白平移，滚轮缩放
 * - 从节点右侧端口拖出连线，落到目标节点完成连接
 * - 选中节点 / 连线后按 Delete 删除
 *
 * 坐标系：节点位置是「世界坐标」，视口变换只作用在 .wf-world 上，
 * 因此拖拽时先用 toWorld 把屏幕坐标换算回世界坐标。
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Bot,
  FileText,
  Flag,
  Maximize2,
  Play,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  DigitalEmployee,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeRunStatus,
} from "@shared/types";
import { NODE_STATUS } from "../../lib/workflowStatus";
import { EmployeeAvatar } from "../employees/EmployeeAvatar";

export const WF_NODE_W = 240;
export const WF_NODE_H = 112;

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;

interface Viewport {
  x: number;
  y: number;
  k: number;
}

/** 连线的几何信息：端点、路径、以及用于挂删除按钮的中点 */
function edgeGeometry(source: WorkflowNode, target: WorkflowNode) {
  const x1 = source.position.x + WF_NODE_W;
  const y1 = source.position.y + WF_NODE_H / 2;
  const x2 = target.position.x;
  const y2 = target.position.y + WF_NODE_H / 2;
  const dx = Math.max(56, Math.abs(x2 - x1) * 0.5);
  return {
    x1,
    y1,
    x2,
    y2,
    d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
    mx: (x1 + x2) / 2,
    my: (y1 + y2) / 2,
  };
}

interface WorkflowCanvasProps {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  employees: DigitalEmployee[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onChange: (nodes: WorkflowNode[], edges: WorkflowEdge[]) => void;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  /** 每次自增触发一次「适应画布」（自动布局后用） */
  fitRequest?: number;
  /** 调试中的节点状态：nodeId → 状态 */
  nodeStates?: Record<string, WorkflowNodeRunStatus>;
}

export function WorkflowCanvas({
  nodes,
  edges,
  employees,
  selectedNodeId,
  selectedEdgeId,
  onChange,
  onSelectNode,
  onSelectEdge,
  fitRequest = 0,
  nodeStates = {},
}: WorkflowCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ x: 80, y: 60, k: 1 });
  const [panning, setPanning] = useState(false);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(
    null,
  );
  const [connecting, setConnecting] = useState<{
    from: string;
    x: number;
    y: number;
  } | null>(null);
  /** 拖动已有连线的目标端点，改连到另一个节点 */
  const [reconnect, setReconnect] = useState<{
    edgeId: string;
    source: string;
    x: number;
    y: number;
  } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const fittedRef = useRef(false);
  const markerId = `wf-arrow-${useId().replace(/:/g, "")}`;

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    const sx = clientX - (rect?.left ?? 0);
    const sy = clientY - (rect?.top ?? 0);
    return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k };
  }, []);

  // 空白处按下：取消选中 + 开始平移
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (
      target.closest("[data-node-id]") ||
      target.closest("[data-edge-id]") ||
      target.closest("[data-canvas-ui]")
    ) {
      return;
    }

    onSelectNode(null);
    onSelectEdge(null);
    setPanning(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { ...viewRef.current };

    const move = (ev: PointerEvent) => {
      setView({
        ...origin,
        x: origin.x + (ev.clientX - startX),
        y: origin.y + (ev.clientY - startY),
      });
    };
    const up = () => {
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // 节点拖拽
  const onNodePointerDown = (e: React.PointerEvent, node: WorkflowNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelectNode(node.id);
    onSelectEdge(null);

    const world = toWorld(e.clientX, e.clientY);
    const dx = world.x - node.position.x;
    const dy = world.y - node.position.y;
    setDrag({ id: node.id, dx, dy });

    const snapshot = nodes;
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      onChange(
        snapshot.map((n) =>
          n.id === node.id
            ? { ...n, position: { x: p.x - dx, y: p.y - dy } }
            : n,
        ),
        edges,
      );
    };
    const up = () => {
      setDrag(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // 从输出端口拖出连线
  const startConnect = (e: React.PointerEvent, node: WorkflowNode) => {
    e.stopPropagation();
    e.preventDefault();
    const origin = {
      x: node.position.x + WF_NODE_W,
      y: node.position.y + WF_NODE_H / 2,
    };
    setConnecting({ from: node.id, x: origin.x, y: origin.y });

    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      setConnecting({ from: node.id, x: p.x, y: p.y });
    };
    const up = (ev: PointerEvent) => {
      const el = document.elementFromPoint(
        ev.clientX,
        ev.clientY,
      ) as HTMLElement | null;
      const targetNode = el?.closest("[data-node-id]") as HTMLElement | null;
      const targetId = targetNode?.dataset.nodeId;
      const target = nodes.find((n) => n.id === targetId);

      if (
        targetId &&
        targetId !== node.id &&
        target &&
        target.type !== "start" &&
        !edges.some((x) => x.source === node.id && x.target === targetId)
      ) {
        onChange(nodes, [
          ...edges,
          { id: `e_${Date.now().toString(36)}`, source: node.id, target: targetId },
        ]);
      }
      setConnecting(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** 拖动已选连线的目标端点：松开时落到哪个节点就改连到哪个节点 */
  const startReconnect = (e: React.PointerEvent, edge: WorkflowEdge) => {
    e.stopPropagation();
    e.preventDefault();
    onSelectEdge(edge.id);

    const start = toWorld(e.clientX, e.clientY);
    setReconnect({
      edgeId: edge.id,
      source: edge.source,
      x: start.x,
      y: start.y,
    });

    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      setReconnect({
        edgeId: edge.id,
        source: edge.source,
        x: p.x,
        y: p.y,
      });
    };
    const up = (ev: PointerEvent) => {
      const el = document.elementFromPoint(
        ev.clientX,
        ev.clientY,
      ) as HTMLElement | null;
      const targetEl = el?.closest("[data-node-id]") as HTMLElement | null;
      const targetId = targetEl?.dataset.nodeId;
      const target = nodes.find((n) => n.id === targetId);

      if (
        targetId &&
        target &&
        target.type !== "start" &&
        targetId !== edge.source &&
        !edges.some(
          (x) =>
            x.id !== edge.id &&
            x.source === edge.source &&
            x.target === targetId,
        )
      ) {
        onChange(
          nodes,
          edges.map((x) =>
            x.id === edge.id ? { ...x, target: targetId } : x,
          ),
        );
      }
      setReconnect(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const setZoom = (next: number, sx: number, sy: number) => {
    const v = viewRef.current;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    setView({
      k,
      x: sx - (sx - v.x) * (k / v.k),
      y: sy - (sy - v.y) * (k / v.k),
    });
  };

  const zoomBy = (factor: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setZoom(viewRef.current.k * factor, rect.width / 2, rect.height / 2);
  };

  // 滚轮缩放。原生监听以便 preventDefault（React 的 wheel 是 passive）
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom(viewRef.current.k * factor, sx, sy);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const fitView = useCallback(() => {
    if (nodes.length === 0) {
      setView({ x: 80, y: 60, k: 1 });
      return;
    }
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const minX = Math.min(...nodes.map((n) => n.position.x));
    const minY = Math.min(...nodes.map((n) => n.position.y));
    const maxX = Math.max(...nodes.map((n) => n.position.x + WF_NODE_W));
    const maxY = Math.max(...nodes.map((n) => n.position.y + WF_NODE_H));
    const pad = 70;
    const k = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        Math.min(
          (rect.width - pad * 2) / (maxX - minX),
          (rect.height - pad * 2) / (maxY - minY),
        ),
      ),
    );
    setView({
      k,
      x: (rect.width - (maxX - minX) * k) / 2 - minX * k,
      y: (rect.height - (maxY - minY) * k) / 2 - minY * k,
    });
  }, [nodes]);

  // 首次加载时把内容放进可视区域
  useEffect(() => {
    if (!fittedRef.current && nodes.length > 0) {
      fittedRef.current = true;
      setTimeout(fitView, 30);
    }
  }, [nodes.length, fitView]);

  // 自动布局后重新适配视口（只响应外部请求，不在普通编辑时抢镜头）
  const lastFitRequest = useRef(0);
  useEffect(() => {
    if (fitRequest === lastFitRequest.current) return;
    lastFitRequest.current = fitRequest;
    if (fitRequest > 0) fitView();
  }, [fitRequest, fitView]);

  // Delete / Backspace 删除选中项（输入框内不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      if (selectedNodeId) {
        e.preventDefault();
        onChange(
          nodes.filter((n) => n.id !== selectedNodeId),
          edges.filter(
            (x) => x.source !== selectedNodeId && x.target !== selectedNodeId,
          ),
        );
        onSelectNode(null);
      } else if (selectedEdgeId) {
        e.preventDefault();
        onChange(nodes, edges.filter((x) => x.id !== selectedEdgeId));
        onSelectEdge(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    nodes,
    edges,
    selectedNodeId,
    selectedEdgeId,
    onChange,
    onSelectNode,
    onSelectEdge,
  ]);

  const nodeById = (id: string) => nodes.find((n) => n.id === id);

  return (
    <div
      ref={canvasRef}
      className={`wf-canvas ${panning ? "panning" : ""}`}
      onPointerDown={onCanvasPointerDown}
    >
      {/* 居中容器负责定位，胶囊自身不再做 translate —— 避免半像素位移让文字发虚 */}
      <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
        <span className="ui-ring rounded-full bg-bg px-4 py-2 text-body leading-none text-text-secondary">
          拖拽节点移动 · 右侧圆点连线 · 选中连线可删除或拖动端点改连 · 滚轮缩放
        </span>
      </div>

      <div
        className="wf-world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        <svg className="wf-svg">
          {edges
            // 改连过程中先隐藏原连线，避免视觉上出现两条
            .filter((edge) => edge.id !== reconnect?.edgeId)
            .map((edge) => {
              const s = nodeById(edge.source);
              const t = nodeById(edge.target);
              if (!s || !t) return null;
              const geo = edgeGeometry(s, t);
              const active = edge.id === selectedEdgeId;
              return (
                <g
                  key={edge.id}
                  data-edge-id={edge.id}
                  className="wf-edge"
                >
                  <path
                    className="wf-edge-hit"
                    d={geo.d}
                    stroke="transparent"
                    strokeWidth={24}
                    fill="none"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      onSelectEdge(edge.id);
                      onSelectNode(null);
                    }}
                  />
                  <path
                    className="wf-edge-line"
                    d={geo.d}
                    fill="none"
                    stroke="var(--c-accent)"
                    strokeOpacity={active ? 1 : 0.45}
                    strokeWidth={active ? 2.4 : 1.8}
                    markerEnd={`url(#${markerId})`}
                  />
                </g>
              );
            })}

          {connecting &&
            (() => {
              const s = nodeById(connecting.from);
              if (!s) return null;
              const x1 = s.position.x + WF_NODE_W;
              const y1 = s.position.y + WF_NODE_H / 2;
              const dx = Math.max(56, Math.abs(connecting.x - x1) * 0.5);
              return (
                <path
                  d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${connecting.x - dx} ${connecting.y}, ${connecting.x} ${connecting.y}`}
                  stroke="var(--c-accent)"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  fill="none"
                />
              );
            })()}

          {reconnect &&
            (() => {
              const s = nodeById(reconnect.source);
              if (!s) return null;
              const x1 = s.position.x + WF_NODE_W;
              const y1 = s.position.y + WF_NODE_H / 2;
              const dx = Math.max(56, Math.abs(reconnect.x - x1) * 0.5);
              return (
                <path
                  d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${reconnect.x - dx} ${reconnect.y}, ${reconnect.x} ${reconnect.y}`}
                  stroke="var(--c-accent)"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  fill="none"
                />
              );
            })()}

          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={6}
              markerHeight={6}
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--c-accent)" />
            </marker>
          </defs>
        </svg>

        {nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            employee={employees.find((e) => e.id === node.config.employeeId)}
            selected={selectedNodeId === node.id}
            dragging={drag?.id === node.id}
            state={nodeStates[node.id]}
            onPointerDown={onNodePointerDown}
            onStartConnect={startConnect}
          />
        ))}

        {/* 选中连线后的操作层：× 删除，拖动端点改连 */}
        {selectedEdgeId &&
          !reconnect &&
          (() => {
            const edge = edges.find((item) => item.id === selectedEdgeId);
            if (!edge) return null;
            const source = nodeById(edge.source);
            const target = nodeById(edge.target);
            if (!source || !target) return null;
            const geo = edgeGeometry(source, target);

            return (
              <>
                <button
                  type="button"
                  data-canvas-ui
                  className="wf-edge-delete"
                  style={{ left: geo.mx, top: geo.my }}
                  title="删除这条连线"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    onChange(
                      nodes,
                      edges.filter((item) => item.id !== edge.id),
                    );
                    onSelectEdge(null);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
                <div
                  className="wf-reconnect"
                  style={{ left: geo.x2, top: geo.y2 }}
                  title="拖动改连到其他节点"
                  onPointerDown={(e) => startReconnect(e, edge)}
                />
              </>
            );
          })()}
      </div>

      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <p className="rounded-xl border border-dashed border-border px-6 py-4 text-body-lg text-text-muted">
            从左侧点击「节点」或数字员工，开始编排
          </p>
        </div>
      )}

      <div
        data-canvas-ui
        className="ui-ring ui-glass absolute bottom-3 left-3 z-10 flex items-center gap-1 rounded-lg p-1"
      >
        <button
          type="button"
          onClick={() => zoomBy(1.15)}
          title="放大"
          className="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-hover hover:text-text active:scale-95"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.15)}
          title="缩小"
          className="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-hover hover:text-text active:scale-95"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={fitView}
          title="适应画布"
          className="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-hover hover:text-text active:scale-95"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
        <span className="px-2 font-mono text-meta text-text-muted">
          {Math.round(view.k * 100)}%
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// 节点卡片
// ============================================================================

function NodeCard({
  node,
  employee,
  selected,
  dragging,
  state,
  onPointerDown,
  onStartConnect,
}: {
  node: WorkflowNode;
  employee: DigitalEmployee | undefined;
  selected: boolean;
  dragging: boolean;
  /** 调试中的节点状态；未调试时为 undefined */
  state?: WorkflowNodeRunStatus;
  onPointerDown: (e: React.PointerEvent, node: WorkflowNode) => void;
  onStartConnect: (e: React.PointerEvent, node: WorkflowNode) => void;
}) {
  const desc =
    node.type === "start"
      ? "工作流入口"
      : node.type === "end"
        ? "工作流出口"
        : employee
          ? `数字员工 · ${employee.name}`
          : "未绑定数字员工";

  /** 画布上只保留最影响流程走向的两条信息：失败策略 + 是否人工审核 */
  const failureLabel =
    node.config.failureStrategy === "skip"
      ? "失败跳过"
      : node.config.failureStrategy === "retry"
        ? `重试 ${node.config.maxRetries} 次`
        : "失败停止";

  const stateMeta = state ? NODE_STATUS[state] : null;
  const StateIcon = stateMeta?.icon;
  const spinning = state === "running" || state === "retrying";

  return (
    <div
      data-node-id={node.id}
      data-state={state}
      className={`wf-node ${selected ? "selected" : ""} ${dragging ? "dragging" : ""} ${
        state ? `state-${state}` : ""
      }`}
      style={{
        left: node.position.x,
        top: node.position.y,
        width: WF_NODE_W,
        height: WF_NODE_H,
      }}
      onPointerDown={(e) => onPointerDown(e, node)}
    >
      <div className="wf-node-head">
        {node.type === "employee" && employee ? (
          <EmployeeAvatar employee={employee} size={28} />
        ) : (
          <span
            className={`wf-node-icon ${
              node.type === "start"
                ? "bg-success/10 text-success"
                : node.type === "end"
                  ? "bg-surface-hover text-text-muted"
                  : "bg-accent-soft text-accent"
            }`}
          >
            {node.type === "start" ? (
              <Play className="h-4 w-4" />
            ) : node.type === "end" ? (
              <Flag className="h-4 w-4" />
            ) : (
              <Bot className="h-4 w-4" />
            )}
          </span>
        )}
        <span className="wf-node-title">{node.name}</span>

        {stateMeta && state !== "pending" && StateIcon ? (
          <span
            title={stateMeta.label}
            className={`shrink-0 ${stateMeta.className}`}
          >
            <StateIcon
              className={`h-4 w-4 ${spinning ? "animate-spin" : ""}`}
            />
          </span>
        ) : (
          node.type === "employee" &&
          node.config.taskDetail.trim() && (
            <span title="已填写任务详情" className="shrink-0 text-text-muted">
              <FileText className="h-3.5 w-3.5" />
            </span>
          )
        )}
      </div>

      <div className="wf-node-body">
        <p className="wf-node-desc">{desc}</p>
        {node.type === "employee" && (
          <div className="wf-node-meta">
            {stateMeta && state !== "pending" ? (
              <span className="wf-node-chip" data-state={state}>
                {stateMeta.label}
              </span>
            ) : employee ? (
              <span className="wf-node-chip">{failureLabel}</span>
            ) : (
              <span className="wf-node-chip warn">待配置</span>
            )}
            {(!state || state === "pending") &&
              employee &&
              node.config.reviewMode === "manual" && (
                <span className="wf-node-chip">人工审核</span>
              )}
          </div>
        )}
      </div>

      {node.type !== "start" && <div className="wf-port in" title="输入" />}
      {node.type !== "end" && (
        <div
          className="wf-port out"
          title="拖出连线"
          onPointerDown={(e) => onStartConnect(e, node)}
        />
      )}
    </div>
  );
}
