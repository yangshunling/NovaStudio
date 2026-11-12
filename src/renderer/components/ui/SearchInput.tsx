/**
 * 搜索输入框
 *
 * 收敛各 View 里重复手写的「圆角搜索框 + 图标 + 清除按钮」。
 *
 *   <SearchInput value={query} onChange={setQuery} placeholder="搜索名称 / 描述" />
 *   <SearchInput size="sm" value={...} onChange={...} placeholder="搜索名称" />
 *   <SearchInput widthClass="w-full" value={...} onChange={...} />
 *
 * size:
 * - "md"：h-9，大图标/大字号，用于页头主搜索（MCP / 技能）
 * - "sm"：h-8，小图标/小字号，用于侧栏、面板内搜索（员工 / 工作区 / 知识库）
 */

import { Search, X } from "lucide-react";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: "md" | "sm";
  /** 容器宽度，默认 md=w-64 / sm=w-52（需要 w-full 时传入即可） */
  widthClass?: string;
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  size = "md",
  widthClass,
  className = "",
}: SearchInputProps) {
  const md = size === "md";
  return (
    <div
      className={`ui-ring flex items-center gap-1.5 rounded-input bg-input-bg text-text ${
        md ? "h-9 px-3.5" : "h-8 px-3"
      } ${widthClass ?? (md ? "w-64" : "w-52")} ${className}`.trim()}
    >
      <Search
        className={`shrink-0 text-text-muted ${md ? "h-4 w-4" : "h-3.5 w-3.5"}`}
      />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`min-w-0 flex-1 bg-transparent outline-none placeholder-text-muted ${
          md ? "ui-type-body" : "ui-type-note"
        }`}
      />
      {value !== "" && (
        <button
          type="button"
          onClick={() => onChange("")}
          title="清除搜索"
          aria-label="清除搜索"
          className="shrink-0 rounded-full p-0.5 text-text-muted transition-colors hover:text-text"
        >
          <X className={md ? "h-3.5 w-3.5" : "h-3 w-3"} />
        </button>
      )}
    </div>
  );
}