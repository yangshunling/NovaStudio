import assert from "node:assert/strict";
import { test } from "node:test";
import { GraphValidationError, validateGraph } from "../src/shared/workflow-graph.ts";
import type { DigitalEmployee, WorkflowGraph, WorkflowNode } from "../src/shared/types.ts";

function node(id: string, type: WorkflowNode["type"], employeeId: string | null = null): WorkflowNode {
  return {
    id,
    type,
    name: id,
    position: { x: 0, y: 0 },
    config: {
      employeeId,
      taskDetail: "",
      failureStrategy: "stop",
      maxRetries: 1,
      maxRevisions: 1,
      reviewMode: "auto",
    },
  };
}

function employee(id: string, enabled = true): DigitalEmployee {
  return {
    id,
    name: id,
    role: "",
    description: "",
    avatar: null,
    systemPrompt: "",
    mcpServers: [],
    skills: [],
    knowledgeBases: [],
    enabled,
    createdAt: 0,
    updatedAt: 0,
  };
}

function graph(nodes: WorkflowNode[], edges: Array<[string, string]>): WorkflowGraph {
  return {
    nodes,
    edges: edges.map(([source, target], index) => ({
      id: `e${index}`,
      source,
      target,
    })),
  };
}

test("合法串行图返回拓扑序与直接前驱", () => {
  const g = graph(
    [node("s", "start"), node("a", "employee", "emp-a"), node("b", "employee", "emp-b"), node("e", "end")],
    [["s", "a"], ["a", "b"], ["b", "e"]],
  );
  const employees = new Map([
    ["emp-a", employee("emp-a")],
    ["emp-b", employee("emp-b")],
  ]);

  const validated = validateGraph(g, employees);
  assert.deepEqual(validated.order.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(validated.predecessors.get("b"), ["a"]);
});

test("拒绝环", () => {
  const g = graph(
    [node("s", "start"), node("a", "employee", "e1"), node("b", "employee", "e1"), node("e", "end")],
    [["s", "a"], ["a", "b"], ["b", "a"], ["b", "e"]],
  );
  const employees = new Map([["e1", employee("e1")]]);
  assert.throws(
    () => validateGraph(g, employees),
    (err: unknown) =>
      err instanceof GraphValidationError && err.issues.some((issue) => issue.includes("环")),
  );
});

test("拒绝未绑定 / 停用的员工与不可达节点", () => {
  const g = graph(
    [node("s", "start"), node("a", "employee", null), node("b", "employee", "disabled"), node("e", "end")],
    [["s", "a"], ["a", "e"]],
  );
  const employees = new Map([["disabled", employee("disabled", false)]]);

  assert.throws(
    () => validateGraph(g, employees),
    (err: unknown) =>
      err instanceof GraphValidationError &&
      err.issues.some((issue) => issue.includes("未绑定数字员工")) &&
      err.issues.some((issue) => issue.includes("已停用")) &&
      err.issues.some((issue) => issue.includes("不可达")),
  );
});

test("必须只有一个开始节点和一个结束节点", () => {
  const g = graph([node("s1", "start"), node("s2", "start"), node("a", "employee", "e1")], [["s1", "a"]]);
  const employees = new Map([["e1", employee("e1")]]);
  assert.throws(
    () => validateGraph(g, employees),
    (err: unknown) =>
      err instanceof GraphValidationError &&
      err.issues.some((issue) => issue.includes("有且仅有一个开始节点")) &&
      err.issues.some((issue) => issue.includes("缺少结束节点")),
  );
});

test("结束节点必须有入边、开始节点不能有入边", () => {
  const g = graph(
    [node("s", "start"), node("a", "employee", "e1"), node("e", "end")],
    [["e", "s"], ["s", "a"], ["a", "e"]],
  );
  const employees = new Map([["e1", employee("e1")]]);
  assert.throws(
    () => validateGraph(g, employees),
    (err: unknown) =>
      err instanceof GraphValidationError &&
      err.issues.some((issue) => issue.includes("开始节点不能有入边")) &&
      err.issues.some((issue) => issue.includes("结束节点不能有出边")),
  );
});

test("执行节点必须能到达结束节点，悬空的结束节点也会被拒绝", () => {
  const g = graph(
    [node("s", "start"), node("a", "employee", "e1"), node("e", "end")],
    [["s", "a"]],
  );
  const employees = new Map([["e1", employee("e1")]]);
  assert.throws(
    () => validateGraph(g, employees),
    (err: unknown) =>
      err instanceof GraphValidationError &&
      err.issues.some((issue) => issue.includes("无法到达结束节点")) &&
      err.issues.some((issue) => issue.includes("结束节点「e」从开始节点不可达")),
  );
});

test("分支不会阻断运行，但会提示并行写文件的冲突风险", () => {
  const g = graph(
    [
      node("s", "start"),
      node("a", "employee", "e1"),
      node("b", "employee", "e1"),
      node("c", "employee", "e1"),
      node("e", "end"),
    ],
    [["s", "a"], ["s", "b"], ["a", "c"], ["b", "c"], ["c", "e"]],
  );
  const employees = new Map([["e1", employee("e1")]]);
  const validated = validateGraph(g, employees);
  assert.ok(
    validated.warnings.some((warning) => warning.includes("分支会并行执行")),
  );
  assert.ok(
    validated.warnings.some((warning) => warning.includes("AND 汇合")),
  );
});
