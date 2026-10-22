/**
 * 数字员工 — 卡片画廊
 *
 * 主区域展示全部数字员工，点击卡片从右侧滑出编辑抽屉。
 * 头像、人设、系统提示词、MCP 与技能都在抽屉内编辑；
 * 列表只负责概览与搜索，避免把大量配置项堆在卡片上。
 */

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  MessageSquareText,
  Plug,
  Plus,
  Search,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { useChatStore } from "../../stores/chat";
import { SkinStage } from "../SkinStage";
import { AgentPill } from "../ui/AgentPill";
import { EmployeeAvatar } from "./EmployeeAvatar";
import { EmployeeDrawer } from "./EmployeeDrawer";
import type { AgentInfo } from "@shared/contracts/agent";
import type { DigitalEmployee } from "@shared/types";

export function EmployeesView() {
  const agents = useChatStore((state) => state.agents);
  const [employees, setEmployees] = useState<DigitalEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** undefined = 抽屉关闭；null = 新建；对象 = 编辑 */
  const [editing, setEditing] = useState<DigitalEmployee | null | undefined>(
    undefined,
  );

  const load = async () => {
    try {
      setEmployees(await ipc.listEmployees());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return employees;
    return employees.filter((employee) =>
      [employee.name, employee.role, employee.description].some((value) =>
        value.toLowerCase().includes(keyword),
      ),
    );
  }, [employees, query]);

  const openCreate = () => setEditing(null);

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <SkinStage />

      <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden rounded-xl">
        {/* 顶栏：标题 / 搜索 / 新建 */}
        <header className="ui-glass relative z-10 flex h-[var(--c-layout-header)] shrink-0 items-center justify-between gap-3 border-b border-border px-card">
          <div className="flex min-w-0 items-center gap-2">
            <span className="ui-serif text-title font-semibold tracking-wide text-text-secondary">
              数字员工
            </span>
            <span className="rounded-full bg-surface-hover px-2 py-0.5 text-caption font-mono text-text-muted">
              {employees.length} 位
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <div className="ui-ring flex h-8 w-52 items-center gap-1.5 rounded-full bg-input-bg px-3">
              <Search className="h-3.5 w-3.5 shrink-0 text-text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称 / 职位"
                className="min-w-0 flex-1 bg-transparent text-meta text-text placeholder-text-muted outline-none"
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
              className="ui-btn-primary flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-meta font-medium"
            >
              <Plus className="h-4 w-4" />
              新建数字员工
            </button>
          </div>
        </header>

        {/* 画廊 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-section">
          {loading ? (
            <div className="flex h-60 items-center justify-center gap-2 text-body text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载数字员工
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
          ) : employees.length === 0 ? (
            <EmptyState onCreate={openCreate} />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center text-text-muted">
              <Search className="h-6 w-6 opacity-50" />
              <p className="text-body">没有匹配「{query}」的数字员工</p>
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
              {filtered.map((employee) => (
                <EmployeeCard
                  key={employee.id}
                  employee={employee}
                  agents={agents}
                  onOpen={() => setEditing(employee)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 编辑抽屉 */}
      {editing !== undefined && (
        <EmployeeDrawer
          key={editing?.id ?? "new"}
          employee={editing}
          agents={agents}
          onClose={() => setEditing(undefined)}
          onSaved={load}
        />
      )}
    </main>
  );
}

// ============================================================================
// 员工卡片
// ============================================================================

function EmployeeCard({
  employee,
  agents,
  onOpen,
}: {
  employee: DigitalEmployee;
  agents: AgentInfo[];
  onOpen: () => void;
}) {
  const mcpCount = employee.mcpServers.filter((server) => server.enabled).length;
  const skillCount = employee.skills.filter((skill) => skill.enabled).length;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative flex h-full min-h-40 flex-col rounded-xl border border-border bg-surface-2/60 p-card text-left transition-all hover:-translate-y-0.5 hover:border-border-strong hover:bg-surface-2/85 hover:shadow-[var(--c-shadow-sm)]"
    >
      <div className="flex items-start gap-3">
        <EmployeeAvatar employee={employee} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              title={employee.enabled ? "已启用" : "已停用"}
              aria-label={employee.enabled ? "已启用" : "已停用"}
              className={`h-2 w-2 shrink-0 rounded-full ${
                employee.enabled ? "bg-success" : "bg-error"
              }`}
            />
            <h3 className="truncate text-title font-semibold text-text">
              {employee.name}
            </h3>
          </div>
          <p className="mt-0.5 truncate text-meta text-text-muted">
            {employee.role || "未设置职位"}
          </p>
          {employee.agentId && (
            <div className="mt-1.5">
              <AgentPill
                agents={agents}
                agentId={employee.agentId}
                maxWidth="max-w-[120px]"
              />
            </div>
          )}
        </div>
      </div>

      <p className="mt-2.5 line-clamp-2 text-body leading-relaxed text-text-secondary">
        {employee.description || "暂无简介"}
      </p>

      {/* mt-auto 把工具标签顶到卡片底部：网格拉伸产生的多余高度留在简介与标签之间，
          而不是堆在标签下面，保证卡片上、下、左、右的 padding 一致 */}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2.5 text-caption text-text-muted">
        <span className="flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5">
          <Plug className="h-3 w-3" />
          {mcpCount} MCP
        </span>
        <span className="flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5">
          <Sparkles className="h-3 w-3" />
          {skillCount} 技能
        </span>
        {employee.systemPrompt && (
          <span
            title="已配置系统提示词"
            className="flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5"
          >
            <MessageSquareText className="h-3 w-3" />
            提示词
          </span>
        )}
      </div>
    </button>
  );
}

// ============================================================================
// 空态
// ============================================================================

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-20 text-center text-text-muted">
      <div className="ui-btn-round flex h-16 w-16 items-center justify-center rounded-2xl">
        <Users className="h-6 w-6" />
      </div>
      <h2 className="ui-serif text-heading font-semibold text-text-secondary">
        组建你的数字团队
      </h2>
      <p className="text-body leading-relaxed">
        每位数字员工都可以拥有独立的头像、人设、系统提示词、MCP
        服务与技能。
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="ui-btn-primary mt-2 flex items-center gap-1.5 rounded-full px-4 py-2 text-body font-medium"
      >
        <Plus className="h-4 w-4" />
        新建数字员工
      </button>
    </div>
  );
}
