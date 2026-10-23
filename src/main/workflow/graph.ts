/**
 * 工作流图校验与拓扑排序
 *
 * P0 只支持串行执行：节点按拓扑序一个接一个跑。
 * 校验失败时直接拒绝启动，而不是运行到一半才发现问题。
 */

import type {
  DigitalEmployee,
  WorkflowGraph,
  WorkflowNode,
} from "../../shared/types";

export interface ValidatedGraph {
  /** 执行节点（不含开始 / 结束），已按拓扑序排列 */
  order: WorkflowNode[];
  /** nodeId → 直接前驱 nodeId 列表（仅执行节点） */
  predecessors: Map<string, string[]>;
}

export class GraphValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join("\n"));
    this.name = "GraphValidationError";
  }
}

export function validateGraph(
  graph: WorkflowGraph,
  employees: Map<string, DigitalEmployee>,
): ValidatedGraph {
  const issues: string[] = [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  const starts = graph.nodes.filter((node) => node.type === "start");
  if (starts.length !== 1) {
    issues.push(`工作流必须有且仅有一个开始节点（当前 ${starts.length} 个）`);
  }

  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      issues.push(`连线 ${edge.id} 指向了不存在的节点`);
    }
    if (edge.source === edge.target) {
      issues.push(`节点「${byId.get(edge.source)?.name ?? edge.source}」存在自连`);
    }
  }

  // 邻接表 + 入度
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

  // Kahn 拓扑排序；排不完说明有环
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

  // 从开始节点做可达性检查
  const reachable = new Set<string>();
  if (starts.length === 1) {
    const stack = [starts[0].id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const next of outgoing.get(id) ?? []) stack.push(next);
    }
  }

  const executable = sorted
    .map((id) => byId.get(id))
    .filter((node): node is WorkflowNode => !!node && node.type === "employee");

  for (const node of executable) {
    if (!reachable.has(node.id)) {
      issues.push(`节点「${node.name}」从开始节点不可达`);
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
    if (!employee.agentId) {
      issues.push(`数字员工「${employee.name}」未指定 Agent`);
    }
  }

  if (executable.length === 0) {
    issues.push("工作流中没有可执行的数字员工节点");
  }

  const hasEnd = graph.nodes.some((node) => node.type === "end");
  if (!hasEnd) {
    issues.push("工作流缺少结束节点");
  }

  if (issues.length > 0) throw new GraphValidationError(issues);

  const predecessors = new Map<string, string[]>();
  for (const node of executable) {
    const incoming = graph.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => edge.source)
      .filter((id) => byId.get(id)?.type === "employee");
    predecessors.set(node.id, incoming);
  }

  return { order: executable, predecessors };
}
