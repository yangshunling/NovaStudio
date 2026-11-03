/**
 * 数字员工 — 卡片画廊
 *
 * 主区域展示全部数字员工，点击卡片从右侧滑出编辑抽屉。
 * 头像、职位、系统提示词、MCP、技能与知识库都在抽屉内编辑；
 * 列表只负责概览与搜索，避免把大量配置项堆在卡片上。
 */

import { useEffect, useMemo, useState } from "react";
import {
  Library,
  Plug,
  Plus,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import { useEmployeesStore } from "../../stores/employees";
import { EmptyState, ErrorState, LoadingState } from "../ui/EmptyState";
import { Page, PageBody, PageHeader } from "../ui/Page";
import { Button } from "../ui/Button";
import { SearchInput } from "../ui/SearchInput";
import { EmployeeAvatar } from "./EmployeeAvatar";
import { EmployeeDrawer } from "./EmployeeDrawer";
import type { DigitalEmployee } from "@shared/types";

export function EmployeesView() {
  // 员工列表以全局 store 为唯一来源（其他资产页也读同一份）
  const employees = useEmployeesStore((s) => s.employees);
  const loading = useEmployeesStore((s) => s.loading);
  const error = useEmployeesStore((s) => s.error);
  const load = useEmployeesStore((s) => s.load);
  const [query, setQuery] = useState("");
  /** undefined = 抽屉关闭；null = 新建；对象 = 编辑 */
  const [editing, setEditing] = useState<DigitalEmployee | null | undefined>(
    undefined,
  );

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return employees;
    return employees.filter((employee) =>
      [employee.name, employee.role, employee.systemPrompt].some((value) =>
        value.toLowerCase().includes(keyword),
      ),
    );
  }, [employees, query]);

  const openCreate = () => setEditing(null);

  return (
    <Page>
      {/* 顶栏：标题 / 搜索 / 新建 */}
      <PageHeader
        title="数字员工"
        count={employees.length}
        countSuffix=" 位"
        actions={
          <>
            <SearchInput
              size="sm"
              widthClass="w-52"
              value={query}
              onChange={setQuery}
              placeholder="搜索名称 / 职位"
            />

            <button
              type="button"
              onClick={openCreate}
              className="ui-btn-primary flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-meta font-medium"
            >
              <Plus className="h-4 w-4" />
              新建数字员工
            </button>
          </>
        }
      />

      {/* 画廊 */}
      <PageBody>
          {loading ? (
            <LoadingState text="正在加载数字员工" />
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load(true)} />
          ) : employees.length === 0 ? (
            <EmptyEmployees onCreate={openCreate} />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Search />}
              title={`没有匹配「${query}」的数字员工`}
              action={
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="text-meta text-accent hover:underline"
                >
                  清除搜索
                </button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((employee) => (
                <EmployeeCard
                  key={employee.id}
                  employee={employee}
                  onOpen={() => setEditing(employee)}
                />
              ))}
            </div>
          )}
      </PageBody>

      {/* 编辑抽屉 */}
      {editing !== undefined && (
        <EmployeeDrawer
          key={editing?.id ?? "new"}
          employee={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => void load(true)}
        />
      )}
    </Page>
  );
}

// ============================================================================
// 员工卡片
// ============================================================================

function EmployeeCard({
  employee,
  onOpen,
}: {
  employee: DigitalEmployee;
  onOpen: () => void;
}) {
  const mcpCount = employee.mcpServers.filter((server) => server.enabled).length;
  const skillCount = employee.skills.filter((skill) => skill.enabled).length;
  const knowledgeCount = employee.knowledgeBases.filter(
    (base) => base.enabled,
  ).length;

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
        </div>
      </div>

      <p className="mt-2.5 line-clamp-2 whitespace-pre-line text-body leading-relaxed text-text-secondary">
        {employee.systemPrompt.trim() || "暂无系统提示词"}
      </p>

      {/* mt-auto 把工具标签顶到卡片底部：网格拉伸产生的多余高度留在提示词与标签之间，
          而不是堆在标签下面，保证卡片上、下、左、右的 padding 一致 */}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2.5 text-caption text-text-muted">
        <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-accent">
          <Plug className="h-3 w-3" />
          {mcpCount} MCP
        </span>
        <span className="flex items-center gap-1 rounded-full bg-agent-violet/10 px-2 py-0.5 text-agent-violet">
          <Sparkles className="h-3 w-3" />
          {skillCount} 技能
        </span>
        <span className="flex items-center gap-1 rounded-full bg-agent-teal/10 px-2 py-0.5 text-agent-teal">
          <Library className="h-3 w-3" />
          {knowledgeCount} 知识库
        </span>
      </div>
    </button>
  );
}

// ============================================================================
// 空态
// ============================================================================
// 空态（首页专用的大号引导）
// ============================================================================

function EmptyEmployees({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      icon={<Users />}
      title="组建你的数字团队"
      description="每位数字员工都可以拥有独立的头像、职位、系统提示词、MCP 服务、技能与知识库。"
      action={
        <Button
          variant="primary"
          onClick={onCreate}
          icon={<Plus className="h-4 w-4" />}
        >
          新建数字员工
        </Button>
      }
    />
  );
}
