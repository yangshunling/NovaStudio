/**
 * 工作流工作台
 *
 * 列表态：展示全部工作流，支持搜索 / 新建 / 删除，点击卡片进入编辑器。
 * 编辑态：交给 WorkflowEditor，左侧节点面板 + 右侧画布。
 *
 * 工作流与数字员工列表在这里一次加载，编辑时直接复用，
 * 避免进入编辑器后左侧员工列表还要再闪一次 loading。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Search, Workflow as WorkflowIcon, X } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { newId, timeAgo } from "../../lib/utils";
import { toast } from "../../stores/toast";
import { SkinStage } from "../SkinStage";
import { Modal, ModalHeader } from "../ui/Modal";
import { ConfirmDeleteButton } from "../ui/ConfirmDeleteButton";
import { WorkflowEditor } from "./WorkflowEditor";
import { defaultNodeConfig } from "./defaults";
import type { DigitalEmployee, Workflow, WorkflowGraph } from "@shared/types";

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
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [employees, setEmployees] = useState<DigitalEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [workflowList, employeeList] = await Promise.all([
        ipc.listWorkflows(),
        ipc.listEmployees(),
      ]);
      setWorkflows(workflowList);
      setEmployees(employeeList);
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

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return workflows;
    return workflows.filter((workflow) =>
      [workflow.name, workflow.description].some((value) =>
        value.toLowerCase().includes(keyword),
      ),
    );
  }, [workflows, query]);

  const editing = workflows.find((workflow) => workflow.id === editingId) ?? null;

  const openCreate = () => {
    setNewName("");
    setNewDescription("");
    setCreating(true);
  };

  const createWorkflow = async () => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    try {
      const workflow = await ipc.createWorkflow({
        name: newName.trim(),
        description: newDescription.trim(),
        graph: seedGraph(),
      });
      setWorkflows((current) => [workflow, ...current]);
      setCreating(false);
      setEditingId(workflow.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const deleteWorkflow = async (workflow: Workflow) => {
    if (!window.confirm(`删除工作流「${workflow.name}」？此操作不可恢复。`)) return;
    try {
      await ipc.deleteWorkflow(workflow.id);
      setWorkflows((current) => current.filter((item) => item.id !== workflow.id));
      if (editingId === workflow.id) setEditingId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (editing) {
    return (
      <WorkflowEditor
        key={editing.id}
        workflow={editing}
        employees={employees}
        onBack={() => setEditingId(null)}
        onSaved={(updated) => {
          setWorkflows((current) =>
            current.map((item) => (item.id === updated.id ? updated : item)),
          );
          setEditingId(null);
          toast.success("工作流已保存");
        }}
      />
    );
  }

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <SkinStage />

      <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden rounded-xl">
        {/* 顶栏：标题 / 搜索 / 新建 */}
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-3 border-b border-border px-card">
          <div className="flex min-w-0 items-center gap-2">
            <WorkflowIcon className="h-4 w-4 shrink-0 text-accent" />
            <span className="ui-serif text-title font-semibold tracking-wide text-text-secondary">
              工作流
            </span>
            <span className="rounded-full bg-surface-hover px-2 py-0.5 font-mono text-meta text-text-muted">
              {workflows.length} 个
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-2">
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
              onClick={openCreate}
              className="ui-btn-primary flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-body font-medium active:scale-95"
            >
              <Plus className="h-4 w-4" />
              新建工作流
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-section">
          {loading ? (
            <div className="flex h-60 items-center justify-center gap-2 text-body text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载工作流
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
          ) : workflows.length === 0 ? (
            <EmptyState onCreate={openCreate} />
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
                  onOpen={() => setEditingId(workflow.id)}
                  onDelete={() => void deleteWorkflow(workflow)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        widthClass="w-[440px] max-w-[90vw]"
      >
        <div className="p-card">
          <ModalHeader title="新建工作流" onClose={() => setCreating(false)} />
          <p className="mb-4 text-body leading-relaxed text-text-muted">
            创建后进入画布：从左侧点击节点或数字员工，把它们连成一条流水线。
          </p>

          <label className="mb-1.5 block text-meta font-medium text-text-secondary">名称</label>
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

          <label className="mb-1.5 block text-meta font-medium text-text-secondary">说明（可选）</label>
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
              onClick={() => setCreating(false)}
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
    </main>
  );
}

// ============================================================================
// 工作流卡片
// ============================================================================

function WorkflowCard({
  workflow,
  onOpen,
  onDelete,
}: {
  workflow: Workflow;
  onOpen: () => void;
  onDelete: () => void;
}) {
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

      <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <ConfirmDeleteButton onConfirm={onDelete} iconSize={15} title="删除工作流" />
      </div>
    </div>
  );
}

// ============================================================================
// 空态
// ============================================================================

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
