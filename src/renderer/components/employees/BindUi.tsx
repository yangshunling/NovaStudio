/**
 * 数字员工资产绑定列表的共用小件
 */

import { Plus, Trash2, type LucideIcon } from "lucide-react";
import { Button } from "../ui/Button";
import { EmptyBlock } from "../ui/EmptyState";

/**
 * 绑定动作：未绑定显示「添加」，已绑定显示「移除」。
 * 列表内联操作，避免「先点添加、再进弹窗选择」的二次跳转。
 */
export function BindAction({
  bound,
  onAdd,
  onRemove,
}: {
  bound: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  if (!bound) {
    return (
      <Button
        variant="primary"
        size="xs"
        icon={<Plus className="h-3 w-3" />}
        onClick={onAdd}
      >
        添加
      </Button>
    );
  }

  return (
    <button
      type="button"
      onClick={onRemove}
      title="从员工中移除"
      className="flex shrink-0 items-center gap-1 rounded-lg border border-error/25 bg-error-bg px-2.5 py-1.5 text-meta font-medium text-error transition-colors hover:bg-error/10"
    >
      <Trash2 className="h-3 w-3" />
      移除
    </button>
  );
}

export function EmptyTab({
  icon: Icon,
  text,
  hint,
}: {
  icon: LucideIcon;
  text: string;
  hint?: string;
}) {
  return (
    <EmptyBlock icon={<Icon />} title={text} description={hint} />
  );
}
