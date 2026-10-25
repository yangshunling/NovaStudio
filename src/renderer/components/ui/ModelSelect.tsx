/**
 * 模型选择控件
 *
 * 选中 Agent 后自动拉取该 Agent 的可选模型：
 * - 有列表：渲染下拉，含「默认（由 Agent 自动决定）」
 * - 无列表（CLI 不支持 / 接口不可用）：回退为自由输入
 * - 获取中：显示加载态
 *
 * 数字员工表单与对话输入框旁的「运行参数」共用本组件，
 * 因此两边不会出现一个能选、一个还要手填的情况。
 */

import { Loader2, RefreshCw } from "lucide-react";
import { useAgentModels } from "../../hooks/useAgentModels";
import { Select } from "./Select";

const CONTROL_CLASS =
  "ui-ring min-w-0 rounded-lg bg-input-bg px-inset py-inset text-body text-text placeholder-text-muted outline-none transition-colors focus:border-input-border-focus";

export function ModelSelect({
  agentId,
  value,
  onChange,
  className = "",
}: {
  agentId: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const { models, loading, refresh } = useAgentModels(agentId);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {loading ? (
        <div
          className={`${CONTROL_CLASS} flex flex-1 items-center gap-2 text-text-muted`}
        >
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          正在获取模型…
        </div>
      ) : models.length > 0 ? (
        <Select
          value={value}
          onChange={onChange}
          className={`${CONTROL_CLASS} flex-1`}
          minMenuWidth={240}
          options={[
            { value: "", label: "默认（由 Agent 自动决定）" },
            ...models.map((model) => ({
              value: model.value,
              label: model.label,
            })),
            ...(value && !models.some((model) => model.value === value)
              ? [{ value, label: `${value}（当前）` }]
              : []),
          ]}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="手动填写模型名"
          className={`${CONTROL_CLASS} flex-1`}
        />
      )}

      <button
        type="button"
        onClick={refresh}
        disabled={!agentId || loading}
        title="刷新模型列表"
        className="shrink-0 rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
      >
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
      </button>
    </div>
  );
}
