/**
 * 数字员工 — 卡片画廊
 *
 * 主区域展示全部数字员工，点击卡片从右侧滑出编辑抽屉。
 * 头像、职位、系统提示词、MCP、技能与知识库都在抽屉内编辑；
 * 列表只负责概览与搜索，避免把大量配置项堆在卡片上。
 */

import { useEffect, useState } from "react";
import {
  ChevronRight,
  Library,
  Plug,
  Plus,
  Sparkles,
  Users,
} from "lucide-react";
import { useEmployeesStore } from "../../stores/employees";
import { useFilteredList } from "../../hooks/useFilteredList";
import {
  EmptyState,
  ErrorState,
  FilterEmpty,
  LoadingState,
} from "../ui/EmptyState";
import { Page, PageBody, PageHeader } from "../ui/Page";
import { Button } from "../ui/Button";
import { SearchInput } from "../ui/SearchInput";
import {
  CARD_DESCRIPTION,
  CARD_META,
  CARD_SHELL,
  CARD_TITLE,
} from "../ui/cardStyles";
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

  const filtered = useFilteredList(employees, query, (employee) => [
    employee.name,
    employee.role,
    employee.systemPrompt,
  ]);

  const openCreate = () => setEditing(null);

  return (
    <Page>
      {/* 顶栏：标题 / 搜索 / 新建 */}
      <PageHeader
        title="数字员工"
        count={employees.length}
        countSuffix=" 位"
        icon={<Users className="h-4 w-4" />}
        actions={
          <>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="搜索名称 / 职位"
            />

            <Button
              variant="primary"
              onClick={openCreate}
              icon={<Plus className="h-4 w-4" />}
            >
              新建数字员工
            </Button>
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
            <FilterEmpty
              title={`没有匹配「${query}」的数字员工`}
              onClear={() => setQuery("")}
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
      className={CARD_SHELL}
    >
      {/* 顶部状态条：启用的员工亮起一条强调色 */}
      <span
        aria-hidden
        className={`absolute inset-x-0 top-0 h-[2px] ${
          employee.enabled ? "bg-accent/70" : "bg-border"
        }`}
      />

      <div className="flex min-w-0 items-start gap-3">
        <EmployeeAvatar employee={employee} size={48} />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className={CARD_TITLE}>{employee.name}</h3>
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 ui-type-sub font-medium ${
                employee.enabled
                  ? "bg-success/10 text-success"
                  : "bg-surface-hover text-text-muted"
              }`}
            >
              {employee.enabled ? "已启用" : "已停用"}
            </span>
          </div>
          <p className="mt-0.5 truncate ui-type-note text-text-muted">
            {employee.role || "未设置职位"}
          </p>
        </div>
        {/* hover 时出现的“可打开”提示，整卡可点但此前没有任何入口暗示 */}
        <ChevronRight className="mt-3 h-4 w-4 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
      </div>

      <p className={`mt-2.5 whitespace-pre-line ${CARD_DESCRIPTION}`}>
        {employee.systemPrompt.trim() || "暂无系统提示词"}
      </p>

      {/* mt-auto 把工具标签顶到卡片底部，保证卡片上、下、左、右的 padding 一致。
          数量为 0 时降级为中性灰：没有绑定任何资产不该和真的绑定了的抢注意力。 */}
      <div className={CARD_META}>
        <UsageChip
          icon={Plug}
          count={mcpCount}
          label="MCP"
          tone="bg-accent-soft text-accent"
        />
        <UsageChip
          icon={Sparkles}
          count={skillCount}
          label="技能"
          tone="bg-agent-violet/10 text-agent-violet"
        />
        <UsageChip
          icon={Library}
          count={knowledgeCount}
          label="知识库"
          tone="bg-agent-teal/10 text-agent-teal"
        />
      </div>
    </button>
  );
}

/** 绑定数量徽标：数量为 0 时静音，避免一屏卡片全是彩色标签 */
function UsageChip({
  icon: Icon,
  count,
  label,
  tone,
}: {
  icon: typeof Plug;
  count: number;
  label: string;
  tone: string;
}) {
  const empty = count === 0;
  return (
    <span
      title={empty ? `未绑定${label}` : `已绑定 ${count} 个${label}`}
      className={`flex items-center gap-1 rounded-full px-2 py-0.5 ${
        empty ? "bg-surface-hover/70 text-text-muted" : tone
      }`}
    >
      <Icon className="h-3 w-3" />
      {count} {label}
    </span>
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
