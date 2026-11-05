/**
 * 工作流图校验与拓扑排序（主进程与渲染进程共用）
 *
 * 设计约定：
 * - 校验失败直接抛出 GraphValidationError，调用方一次拿到全部问题；
 * - 执行引擎按 DAG 并行调度（并发上限 MAX_PARALLEL_NODES），
 *   汇合语义为 AND；分支会同时执行，不是串行 —— 这一点以 warnings
 *   的形式明确告诉用户，避免画布预期与运行结果不一致；
 * - 错误是「不能运行」的问题，警告是「能运行但可能不符合预期」的问题。
 */

import type { DigitalEmployee, WorkflowGraph, WorkflowNode } from "./types";

export interface ValidatedGraph {
  /** 执行节点（不含开始 / 结束），已按拓扑序排列 */
  order: WorkflowNode[];
  /** nodeId → 直接前驱 nodeId 列表（仅执行节点） */
  predecessors: Map<string, string[]>;
  /** 不阻断运行、但需要提示用户的问题 */
  warnings: string[];
}

export class GraphValidationError extends Error {
  readonly issues: string[];
  readonly warnings: string[];

  constructor(issues: string[], warnings: string[] = []) {
    super(issues.join("\n"));
    this.name = "GraphValidationError";
    this.issues = issues;
    this.warnings = warnings;
  }
}

/** 从一组起点沿邻接表做 BFS，返回可达集合 */
function collectReachable(
  startIds: Iterable<string>,
  adjacency: Map<string, string[]>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...startIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adjacency.get(id) ?? []) stack.push(next);
  }
  return seen;
}

export function validateGraph(
  graph: WorkflowGraph,
  employees: Map<string, DigitalEmployee>,
): ValidatedGraph {
  const issues: string[] = [];
  const warnings: string[] = [];

  // ---- 节点 id 唯一性 ----
  const byId = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) issues.push(`存在重复的节点 id：${node.id}`);
    else byId.set(node.id, node);
  }

  // ---- 连线：端点、自连、重复、起止节点方向 ----
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) issues.push(`存在重复的连线 id：${edge.id}`);
    edgeIds.add(edge.id);

    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      issues.push(`连线 ${edge.id} 指向了不存在的节点`);
      continue;
    }
    if (edge.source === edge.target) {
      issues.push(`节点「${source.name}」存在自连`);
    }

    const pair = `${edge.source}\u0000${edge.target}`;
    if (pairs.has(pair)) {
      issues.push(`节点「${source.name}」到「${target.name}」存在重复连线`);
    }
    pairs.add(pair);

    if (target.type === "start") {
      issues.push(`开始节点不能有入边（连线 ${edge.id}）`);
    }
    if (source.type === "end") {
      issues.push(`结束节点不能有出边（连线 ${edge.id}）`);
    }
  }

  // ---- 起止节点 ----
  const starts = graph.nodes.filter((node) => node.type === "start");
  if (starts.length !== 1) {
    issues.push(`工作流必须有且仅有一个开始节点（当前 ${starts.length} 个）`);
  }
  const ends = graph.nodes.filter((node) => node.type === "end");
  if (ends.length === 0) {
    issues.push("工作流缺少结束节点");
  } else if (ends.length > 1) {
    issues.push(`工作流必须有且仅有一个结束节点（当前 ${ends.length} 个）`);
  }

  // ---- 邻接表 + 入度 ----
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of graph.nodes) {
    outgoing.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  // ---- Kahn 拓扑排序；排不完说明有环 ----
  const queue = graph.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  const sorted: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (sorted.length !== graph.nodes.length) {
    issues.push("工作流中存在环，无法确定执行顺序");
  }

  // ---- 从开始节点可达性 ----
  let reachable = new Set<string>();
  if (starts.length === 1) {
    reachable = collectReachable([starts[0].id], outgoing);
    for (const node of graph.nodes) {
      if (!reachable.has(node.id)) {
        issues.push(`节点「${node.name}」从开始节点不可达`);
      }
    }
    for (const end of ends) {
      if (!reachable.has(end.id)) {
        issues.push(`结束节点「${end.name}」从开始节点不可达`);
      }
    }
  }

  // ---- 每个执行节点必须能走到结束节点 ----
  // 反向邻接：从结束节点反向 BFS，得到所有能到达结束节点的节点
  const incoming = new Map<string, string[]>();
  for (const node of graph.nodes) incoming.set(node.id, []);
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    incoming.get(edge.target)!.push(edge.source);
  }
  const canReachEnd = collectReachable(
    ends.map((node) => node.id),
    incoming,
  );

  const executable = sorted
    .map((id) => byId.get(id))
    .filter((node): node is WorkflowNode => !!node && node.type === "employee");

  for (const node of executable) {
    if (ends.length > 0 && !canReachEnd.has(node.id)) {
      issues.push(`节点「${node.name}」无法到达结束节点`);
    }

    const employee = node.config.employeeId
      ? employees.get(node.config.employeeId)
      : undefined;
    if (!employee) {
      issues.push(`节点「${node.name}」未绑定数字员工`);
      continue;
    }
    if (!employee.enabled) {
      issues.push(`节点「${node.name}」绑定的数字员工「${employee.name}」已停用`);
    }
  }

  if (executable.length === 0) {
    issues.push("工作流中没有可执行的数字员工节点");
  }

  // ---- 不阻断运行、但会让结果不符合直觉的配置 ----
  for (const node of graph.nodes) {
    const outs = outgoing.get(node.id) ?? [];
    if (outs.length > 1) {
      warnings.push(
        `节点「${node.name}」有 ${outs.length} 个下游：这些分支会并行执行，请确认它们不会同时写同一个文件。`,
      );
    }
    const ins = incoming.get(node.id) ?? [];
    if (node.type === "employee" && ins.length > 1) {
      warnings.push(
        `节点「${node.name}」有 ${ins.length} 个上游：需要全部上游完成后才会执行（AND 汇合）。`,
      );
    }
  }
  for (const node of executable) {
    if (node.config.failureStrategy === "retry") {
      const retries = node.config.maxRetries;
      if (!Number.isFinite(retries) || retries < 1 || retries > 5) {
        warnings.push(
          `节点「${node.name}」的最大重试次数 ${retries} 超出 1-5，运行时将按范围处理。`,
        );
      }
    }
    if (node.config.reviewMode === "manual") {
      const revisions = node.config.maxRevisions;
      if (!Number.isFinite(revisions) || revisions < 0 || revisions > 3) {
        warnings.push(
          `节点「${node.name}」的最大修改轮数 ${revisions} 超出 0-3，运行时将按范围处理。`,
        );
      }
    }
    if (!node.config.taskDetail.trim()) {
      warnings.push(`节点「${node.name}」未填写任务详情，运行时将使用默认指令。`);
    }
  }

  if (issues.length > 0) throw new GraphValidationError(issues, warnings);

  const predecessors = new Map<string, string[]>();
  for (const node of executable) {
    const incomingEmployeeIds = graph.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => edge.source)
      .filter((id) => byId.get(id)?.type === "employee");
    predecessors.set(node.id, incomingEmployeeIds);
  }

  return {
    order: executable,
    predecessors,
    warnings: [...new Set(warnings)],
  };
}
