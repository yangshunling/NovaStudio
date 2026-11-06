/**
 * 待办编辑弹窗
 *
 * 新建与编辑共用：标题必填，其余字段都可以留空。
 * 弹窗只负责收集草稿，保存成功与否由调用方决定（失败时保持打开）。
 */

import { useEffect, useState } from "react";
import type { TodoDraft, TodoItem, TodoPriority } from "@shared/types";
import { Dialog, DialogActions } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, TextArea, TextInput } from "../ui/Field";
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

interface TodoEditorDialogProps {
  open: boolean;
  /** null 表示新建 */
  todo: TodoItem | null;
  /** 已有标签，供补全 */
  suggestions: string[];
  /** 新建时的默认截止日期（日历选中某天时传入） */
  defaultDueAt?: number | null;
  onClose: () => void;
  onSubmit: (draft: TodoDraft) => Promise<void>;
}

export function TodoEditorDialog({
  open,
  todo,
  suggestions,
  defaultDueAt = null,
  onClose,
  onSubmit,
}: TodoEditorDialogProps) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [priority, setPriority] = useState<TodoPriority>("normal");
  const [dueDate, setDueDate] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // 每次打开时用当前条目重置表单，避免残留上一条的内容
  useEffect(() => {
    if (!open) return;
    setTitle(todo?.title ?? "");
    setNote(todo?.note ?? "");
    setPriority(todo?.priority ?? "normal");
    // 编辑时严格使用条目自身的日期；新建时才采用日历选中的日期
    setDueDate(toDateInputValue(todo ? todo.dueAt : defaultDueAt));
    setTags(todo?.tags ?? []);
    setBusy(false);
  }, [open, todo, defaultDueAt]);

  const submit = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSubmit({
        title: value,
        note: note.trim(),
        priority,
        dueAt: fromDateInputValue(dueDate),
        tags,
      });
    } catch (err) {
      toast.error(toMessage(err), 5000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={todo ? "编辑待办" : "新建待办"}
      width="md"
    >
      <div className="space-y-3">
        <Field label="待办内容" required>
          <TextInput
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter") void submit();
            }}
            placeholder="例如：整理周报的数据"
          />
        </Field>

        <Field label="备注" hint="补充背景、链接或需要留意的细节。">
          <TextArea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            placeholder="可选"
            className="resize-none"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="优先级">
            <OptionChips
              mode="single"
              variant="rect"
              size="md"
              items={PRIORITY_OPTIONS}
              selected={priority}
              onSelect={(id) => setPriority(id as TodoPriority)}
            />
          </Field>

          <Field label="截止日期" hint="留空表示没有截止日期。">
            <TextInput
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </Field>
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

        {todo && (
          <p className="text-caption text-text-muted">
            创建于 {formatDateLabel(todo.createdAt)}
          </p>
        )}
      </div>

      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="primary"
          loading={busy}
          disabled={!title.trim()}
          onClick={() => void submit()}
        >
          保存
        </Button>
      </DialogActions>
    </Dialog>
  );
}
