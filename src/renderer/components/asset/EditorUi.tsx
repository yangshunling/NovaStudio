/**
 * 资产编辑抽屉共用件
 *
 * MCP 服务定义 / 技能文件 / 知识库文档都采用「说明行 + 等宽文本域 + 保存」
 * 的编辑形态，这里统一交互与样式，避免三处各写一份。
 */

import type { ReactNode } from "react";
import { Save } from "lucide-react";
import { Button } from "../ui/Button";

/**
 * 编辑器顶部：左侧说明，右侧保存按钮。
 * 保存按钮由调用方通过 `disabled` 控制（未改动 / 不可编辑时禁用）。
 */
export function EditorBar({
  label,
  saving = false,
  disabled,
  onSave,
  error,
  saveLabel = "保存",
  marginClass = "mb-2",
}: {
  label: ReactNode;
  saving?: boolean;
  disabled: boolean;
  onSave: () => void;
  /** 校验错误：显示在保存按钮左侧 */
  error?: string | null;
  saveLabel?: string;
  /** 外层底边距；嵌在自带内边距的容器里时传 "mb-0" */
  marginClass?: string;
}) {
  return (
    <div
      className={`${marginClass} flex shrink-0 items-center justify-between gap-2`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-meta font-medium text-text-secondary">
        {label}
      </div>
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        {error && (
          <span className="truncate text-meta text-error" title={error}>
            {error}
          </span>
        )}
        <Button
          size="sm"
          variant="primary"
          loading={saving}
          icon={<Save className="h-3.5 w-3.5" />}
          onClick={onSave}
          disabled={disabled}
        >
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

/** 资产编辑器统一的等宽文本域 */
export function CodeTextarea({
  value,
  onChange,
  readOnly = false,
  placeholder,
  minHeightClass = "min-h-[300px]",
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  minHeightClass?: string;
}) {
  return (
    <textarea
      value={value}
      onChange={onChange ? (event) => onChange(event.target.value) : undefined}
      readOnly={readOnly}
      spellCheck={false}
      placeholder={placeholder}
      className={`ui-ring w-full flex-1 resize-none rounded-lg border border-input-border bg-input-bg p-inset font-mono text-body-lg leading-relaxed text-text outline-none ${minHeightClass} ${
        readOnly ? "opacity-80" : "focus:border-input-border-focus"
      }`}
    />
  );
}
