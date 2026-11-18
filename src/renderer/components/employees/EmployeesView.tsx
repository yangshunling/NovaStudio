/**
 * 数字员工 — 卡片画廊
 *
 * 主区域展示全部数字员工，点击卡片从右侧滑出编辑抽屉。
 * 头像、职位、系统提示词、MCP、技能与知识库都在抽屉内编辑；
 * 列表只负责概览与搜索，避免把大量配置项堆在卡片上。
 */

import { useEffect, useState } from "react";
import { Library, Plug, Plus, Sparkles, Users } from "lucide-react";
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
import { Toggle } from "../ui/Toggle";
import { ipc } from "../../lib/ipc";
import { toEmployeeDraft } from "../../lib/employee-draft";
import { toast } from "../../stores/toast";
import { errorMessage } from "@shared/error";
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
  const upsert = useEmployeesStore((s) => s.upsert);
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

  /**
   * 卡片右上角直接切换启用状态，不必打开抽屉再保存。
   * 更新接口要整份草稿，这里基于当前员工快照补上 enabled，其余字段原样带回。
   */
  const toggleEmployee = async (employee: DigitalEmployee, enabled: boolean) => {
    try {
      const updated = await ipc.updateEmployee(employee.id, {
        ...toEmployeeDraft(employee),
        enabled,
      });
      if (!updated) return;
      upsert(updated);
      toast.success(
        enabled
          ? `已启用「${employee.name}」`
          : `已停用「${employee.name}」`,
      );
    } catch (err) {
      toast.error(errorMessage(err), 5000);
    }
  };

  return (
    <Page>
      {/* 顶栏：标题 / 搜索 / 新建 */}
      <PageHeader
        title="数字员工"
        hue="sky"
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
              新建员工
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
            <EmptyEmployees />
          ) : filtered.length === 0 ? (
            <FilterEmpty
              title={`没有匹配「${query}」的数字员工`}
              onClear={() => setQuery("")}
            />
          ) : (
            <div className="ui-stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((employee) => (
                <EmployeeCard
                  key={employee.id}
                  employee={employee}
                  onOpen={() => setEditing(employee)}
                  onToggle={(enabled) => void toggleEmployee(employee, enabled)}
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
  onToggle,
}: {
  employee: DigitalEmployee;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const mcpCount = employee.mcpServers.filter((server) => server.enabled).length;
  const skillCount = employee.skills.filter((skill) => skill.enabled).length;
  const knowledgeCount = employee.knowledgeBases.filter(
    (base) => base.enabled,
  ).length;

  return (
    /*
     * 整卡可点开抽屉；卡片里又有开关，所以不能用 <button>（嵌套交互元素非法）。
     * 用 article + role="button" 保留键盘可达性，开关点击时阻止冒泡。
     */
    <article
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        // 只响应卡片自身的按键：焦点在内部开关上时，Space 属于开关
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`${CARD_SHELL} border-l-2 border-l-hue-sky/50 cursor-pointer`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <EmployeeAvatar employee={employee} size={48} />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <h3 className={`min-w-0 flex-1 ${CARD_TITLE}`}>{employee.name}</h3>
            {/* 启用开关放右上角，与触发器卡片一致；点击不应打开抽屉 */}
            <span
              className="shrink-0"
              onClick={(event) => event.stopPropagation()}
            >
              <Toggle
                checked={employee.enabled}
                onChange={onToggle}
                label={`启用数字员工 ${employee.name}`}
              />
            </span>
          </div>
          <p className="mt-0.5 truncate ui-type-note text-text-muted">
            {employee.role || "未设置职位"}
          </p>
        </div>
      </div>

      <p className={`mt-2.5 ${CARD_DESCRIPTION}`}>
        {employee.description.trim() || "暂无简介"}
      </p>

      {/* mt-auto 把工具标签顶到卡片底部，保证卡片上、下、左、右的 padding 一致。
          三种资产各固定一个分区色（与 cardStyles 的资产色槽位一致），
          无论是否绑定都保持同一种颜色。 */}
      <div className={CARD_META}>
        <UsageChip icon={Plug} count={mcpCount} label="MCP" tone="sky" />
        <UsageChip icon={Sparkles} count={skillCount} label="技能" tone="moss" />
        <UsageChip
          icon={Library}
          count={knowledgeCount}
          label="知识库"
          tone="teal"
        />
      </div>
    </article>
  );
}

/**
 * 绑定数量徽标的固定色槽位。
 *
 * 颜色只标识资产类型，不表达状态：MCP 永远是天蓝、技能永远是苔绿、
 * 知识库永远是青，换卡片、换排序、有没有绑定都不变。
 */
const USAGE_TONES = {
  sky: "border-hue-sky/30 bg-hue-sky/10 text-hue-sky",
  moss: "border-hue-moss/30 bg-hue-moss/10 text-hue-moss",
  teal: "border-hue-teal/30 bg-hue-teal/10 text-hue-teal",
} as const;

type UsageTone = keyof typeof USAGE_TONES;

/** 绑定数量徽标：三种资产各一种固定颜色，空态也保持一致 */
function UsageChip({
  icon: Icon,
  count,
  label,
  tone,
}: {
  icon: typeof Plug;
  count: number;
  label: string;
  tone: UsageTone;
}) {
  return (
    <span
      title={count === 0 ? `未绑定${label}` : `已绑定 ${count} 个${label}`}
      className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${USAGE_TONES[tone]}`}
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

function EmptyEmployees() {
  return (
    <EmptyState
      hue="sky"
      icon={<Users />}
      title="组建你的数字团队"
      description="每位数字员工都可以拥有独立的头像、职位、系统提示词、MCP 服务、技能与知识库。"
    />
  );
}
