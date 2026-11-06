/**
 * 快速添加待办
 *
 * 视觉上是台账的第一行：一个加号 + 一行可输入的文字，而不是一个表单框。
 * 默认回车即保存；需要备注 / 优先级 / 截止日期 / 标签时展开「详细」，
 * 展开后的字段收在同一块浅色面板里，不破坏整页的留白节奏。
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import type { TodoDraft, TodoPriority } from "@shared/types";
import { Button } from "../ui/Button";
import { TextArea, TextInput } from "../ui/Field";
import { OptionChips } from "../ui/OptionChips";
import { TagInput } from "./TagInput";
import {
  PRIORITY_OPTIONS,
  formatDateLabel,
  fromDateInputValue,
  toDateInputValue,
} from "./todoUtils";
import { toast } from "../../stores/toast";
import { toMessage } from "../../lib/utils";

interface TodoComposerProps {
  /** 已有标签，供补全 */
  suggestions: string[];
  /** 日历选中某天时，新待办默认落在这一天 */
  defaultDueAt: number | null;
  onCreate: (draft: TodoDraft) => Promise<void>;
}

export function TodoComposer({
  suggestions,
  defaultDueAt,
  onCreate,
}: TodoComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");
  const [priority, setPriority] = useState<TodoPriority>("normal");
  const [dueDate, setDueDate] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // 日历切换日期时，展开面板里的截止日期跟着切换
  useEffect(() => {
    setDueDate(toDateInputValue(defaultDueAt));
  }, [defaultDueAt]);

  const reset = () => {
    setTitle("");
    setNote("");
    setPriority("normal");
    setDueDate(toDateInputValue(defaultDueAt));
    setTags([]);
  };

  const submit = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onCreate({
        title: value,
        note: expanded ? note.trim() : "",
        priority: expanded ? priority : "normal",
        dueAt: expanded ? fromDateInputValue(dueDate) : defaultDueAt,
        tags: expanded ? tags : [],
      });
      reset();
      inputRef.current?.focus();
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group/composer">
      {/* 左侧留出与行内拖拽手柄同宽的缩进，让加号与勾选框对齐 */}
      <div className="flex items-center gap-2.5 py-3.5 pl-4">
        <Plus className="h-4 w-4 shrink-0 text-text-muted transition-colors group-focus-within/composer:text-accent" />
        <input
          ref={inputRef}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            // 中文输入法选词时回车不能当作提交
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape" && expanded) {
              setExpanded(false);
            }
          }}
          placeholder={
            defaultDueAt !== null
              ? "在这天记一件事，回车添加"
              : "记一件要做的事，回车添加"
          }
          className="min-w-0 flex-1 bg-transparent text-body-lg text-text outline-none placeholder-text-muted"
        />
        {!expanded && defaultDueAt !== null && (
          <span className="shrink-0 text-caption text-text-muted">
            截止 {formatDateLabel(defaultDueAt)}
          </span>
        )}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          title={
            expanded
              ? "收起详细信息"
              : "填写备注 / 优先级 / 截止日期 / 标签"
          }
          className="flex shrink-0 items-center gap-1 text-meta text-text-muted transition-colors hover:text-text"
        >
          {expanded ? "收起" : "详细"}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </button>
      </div>

      {expanded && (
        <div className="mb-4 ml-7 space-y-3 rounded-lg border border-border/70 bg-surface-2/40 p-3">
          <TextArea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            placeholder="补充说明（可选）"
            className="resize-none"
          />

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <div className="flex items-center gap-2">
              <span className="text-meta text-text-muted">优先级</span>
              <OptionChips
                mode="single"
                items={PRIORITY_OPTIONS}
                selected={priority}
                onSelect={(id) => setPriority(id as TodoPriority)}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-meta text-text-muted">截止</span>
              <div className="w-36">
                <TextInput
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                />
              </div>
            </div>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!title.trim()}
              onClick={() => void submit()}
              className="ml-auto"
            >
              添加
            </Button>
          </div>

          <div>
            <div className="mb-1.5 text-meta font-medium text-text-secondary">
              标签
            </div>
            <TagInput
              value={tags}
              onChange={setTags}
              suggestions={suggestions}
            />
          </div>
        </div>
      )}
    </div>
  );
}
