/**
 * 标签输入
 *
 * 已选标签以 chip 展示；回车 / 中英文逗号确认，退格删除最后一个。
 * 下方列出已有标签供点选，避免同一件事写出「工作 / 工作 」两种标签。
 */

import { useState } from "react";
import { X } from "lucide-react";

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  /** 已有标签，用于快速补全 */
  suggestions?: string[];
  placeholder?: string;
  max?: number;
}

/** 统一标签清洗规则：去掉 # 前缀与首尾空白，按逗号拆分 */
export function normalizeTagText(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((part) => part.trim().replace(/^#+/, "").trim())
    .filter(Boolean);
}

export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder = "输入标签后回车",
  max = 8,
}: TagInputProps) {
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    const pieces = normalizeTagText(raw);
    if (pieces.length === 0) return;
    const next = [...value];
    for (const tag of pieces) {
      if (next.length >= max) break;
      if (next.some((item) => item.toLowerCase() === tag.toLowerCase())) {
        continue;
      }
      next.push(tag);
    }
    onChange(next);
    setDraft("");
  };

  const remove = (tag: string) => {
    onChange(value.filter((item) => item !== tag));
  };

  const selectedKeys = new Set(value.map((tag) => tag.toLowerCase()));
  const available = suggestions
    .filter((tag) => !selectedKeys.has(tag.toLowerCase()))
    .slice(0, 12);

  const atLimit = value.length >= max;

  return (
    <div className="ui-ring rounded-lg bg-input-bg p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-meta text-accent"
          >
            #{tag}
            <button
              type="button"
              onClick={() => remove(tag)}
              title={`移除标签 ${tag}`}
              className="rounded-full p-0.5 transition-colors hover:bg-accent/15"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          disabled={atLimit}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => add(draft)}
          onKeyDown={(event) => {
            // 中文输入法选词时回车不能当作确认
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" || event.key === "," || event.key === "，") {
              event.preventDefault();
              add(draft);
              return;
            }
            if (event.key === "Backspace" && !draft && value.length > 0) {
              remove(value[value.length - 1]);
            }
          }}
          placeholder={atLimit ? `最多 ${max} 个标签` : placeholder}
          className="min-w-[120px] flex-1 bg-transparent px-0.5 py-0.5 text-body text-text outline-none placeholder-text-muted disabled:cursor-not-allowed"
        />
      </div>

      {available.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
          <span className="text-caption text-text-muted">已有</span>
          {available.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => add(tag)}
              className="rounded-full bg-surface-2/70 px-2 py-0.5 text-caption text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            >
              #{tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
