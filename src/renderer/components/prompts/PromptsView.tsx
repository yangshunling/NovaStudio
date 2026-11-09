/**
 * 提示词 — 常用提示词库
 *
 * 左：可搜索 / 按标签筛选的提示词列表（最近修改优先）
 * 右：编辑器（标题 / 标签 / 正文），支持复制正文与 Ctrl/⌘+S 保存
 *
 * 这是一个独立功能：只依赖一张 prompts 表，不与会话 / 工作流耦合。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ClipboardCopy,
  MessageSquare,
  MessageSquareText,
  Plus,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { toMessage } from "../../lib/utils";
import { toast } from "../../stores/toast";
import { useChatStore } from "../../stores/chat";
import { useFileViewerStore } from "../../stores/fileViewer";
import { confirmDialog } from "../../stores/confirm";
import { ListItem, ListPane } from "../ui/ListPane";
import { Page, PageBody, PageHeader } from "../ui/Page";
import { Button } from "../ui/Button";
import { SearchInput } from "../ui/SearchInput";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "../ui/EmptyState";
import { Field, TextArea, TextInput } from "../ui/Field";
import { ConfirmDeleteButton } from "../ui/ConfirmDeleteButton";
import { TagInput } from "../todos/TagInput";
import { formatAssetTime } from "../asset/AssetUi";
import type { PromptDraft, PromptItem } from "@shared/types";

/* favorite 字段仍在草稿里透传，只为保留历史数据（界面已无收藏入口）。 */
const EMPTY_DRAFT: PromptDraft = {
  title: "",
  content: "",
  tags: [],
  favorite: false,
};

/** 数据库条目 → 可编辑草稿 */
function toDraft(item: PromptItem): PromptDraft {
  return {
    title: item.title,
    content: item.content,
    tags: [...item.tags],
    favorite: item.favorite,
  };
}

/** 标签顺序也算改动 */
function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/** 列表里展示的摘要：正文第一个非空行 */
function contentSummary(content: string): string {
  const line = content.split("\n").find((part) => part.trim());
  return line?.trim() || "暂无内容";
}

export function PromptsView() {
  const [items, setItems] = useState<PromptItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<PromptDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  /** Ctrl/⌘+S 需要访问最新的保存逻辑 */
  const saveRef = useRef<() => void>(() => {});
  const usePromptInChat = useChatStore((s) => s.usePromptInChat);

  useEffect(() => {
    let alive = true;
    ipc
      .listPrompts()
      .then((list) => {
        if (!alive) return;
        setItems(list);
        const first = list[0] ?? null;
        setSelectedId(first?.id ?? null);
        setForm(first ? toDraft(first) : EMPTY_DRAFT);
      })
      .catch((err) => {
        if (alive) setError(toMessage(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  const allTags = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items) {
      for (const tag of item.tags) {
        const key = tag.toLowerCase();
        if (!seen.has(key)) seen.set(key, tag);
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [items]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      if (tagFilter && !item.tags.includes(tagFilter)) return false;
      if (!keyword) return true;
      return [item.title, item.content, item.tags.join(" ")].some((value) =>
        value.toLowerCase().includes(keyword),
      );
    });
  }, [items, query, tagFilter]);

  const startCreate = () => {
    setCreating(true);
    setSelectedId(null);
    setForm(EMPTY_DRAFT);
  };

  const selectItem = (item: PromptItem) => {
    setCreating(false);
    setSelectedId(item.id);
    setForm(toDraft(item));
  };

  const dirty = creating
    ? form.title !== "" || form.content !== "" || form.tags.length > 0
    : !!selected &&
      (form.title !== selected.title ||
        form.content !== selected.content ||
        !sameTags(form.tags, selected.tags));

  const canSave =
    dirty && !saving && form.title.trim() !== "" && form.content.trim() !== "";

  const save = async () => {
    if (!canSave) return;
    const draft: PromptDraft = { ...form, title: form.title.trim() };
    setSaving(true);
    try {
      if (creating) {
        const item = await ipc.createPrompt(draft);
        setItems((prev) => [item, ...prev]);
        setCreating(false);
        setSelectedId(item.id);
        setForm(toDraft(item));
        toast.success("提示词已创建");
      } else if (selectedId) {
        const item = await ipc.updatePrompt(selectedId, draft);
        if (!item) throw new Error("提示词已不存在，可能已被删除");
        setItems((prev) =>
          prev.map((current) => (current.id === item.id ? item : current)),
        );
        setForm(toDraft(item));
        toast.success("提示词已保存");
      }
    } catch (err) {
      toast.error(toMessage(err));
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = () => void save();

  // Ctrl/⌘+S 保存：编辑长提示词时不打断输入
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const remove = async () => {
    if (!selected) return;
    const ok = await confirmDialog({
      title: "删除这条提示词？",
      message: selected.title,
      tone: "danger",
      confirmLabel: "删除",
    });
    if (!ok) return;
    try {
      const deleted = await ipc.deletePrompt(selected.id);
      if (!deleted) throw new Error("提示词已不存在");
      const remaining = items.filter((item) => item.id !== selected.id);
      const next = remaining[0] ?? null;
      setItems(remaining);
      setSelectedId(next?.id ?? null);
      setForm(next ? toDraft(next) : EMPTY_DRAFT);
      toast.success("已删除");
    } catch (err) {
      toast.error(toMessage(err));
    }
  };

  const copyContent = async () => {
    if (!form.content.trim()) return;
    try {
      await navigator.clipboard.writeText(form.content);
      toast.success("已复制提示词正文");
    } catch {
      toast.error("复制失败，请手动选择文本");
    }
  };

  return (
    <Page>
      {loading ? (
        <LoadingState text="正在加载提示词" className="h-full" />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左：提示词列表 */}
          <ListPane
            title="提示词"
            count={items.length}
            action={
              <button
                type="button"
                onClick={startCreate}
                title="新建提示词"
                aria-label="新建提示词"
                className="ui-btn-round ui-icon-action flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors active:scale-95"
              >
                <Plus className="h-4 w-4" />
              </button>
            }
            footer={
              <Button
                className="w-full"
                onClick={startCreate}
                icon={<Plus className="h-4 w-4" />}
              >
                新建提示词
              </Button>
            }
          >
            <div className="pb-1">
              <SearchInput
                size="sm"
                widthClass="w-full"
                value={query}
                onChange={setQuery}
                placeholder="搜索标题 / 正文 / 标签"
              />
            </div>

            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1 pb-1">
                <TagChip
                  active={tagFilter === null}
                  onClick={() => setTagFilter(null)}
                >
                  全部
                </TagChip>
                {allTags.map((tag) => (
                  <TagChip
                    key={tag}
                    active={tagFilter === tag}
                    onClick={() =>
                      setTagFilter((current) => (current === tag ? null : tag))
                    }
                  >
                    #{tag}
                  </TagChip>
                ))}
              </div>
            )}

            {filtered.length === 0 ? (
              <EmptyState
                size="compact"
                title={items.length === 0 ? "还没有提示词" : "没有匹配的提示词"}
                description={
                  items.length === 0
                    ? "把常用的提示词存进来，随用随取。"
                    : undefined
                }
                action={
                  items.length === 0 ? (
                    <Button size="sm" onClick={startCreate}>
                      新建提示词
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              filtered.map((item) => (
                <ListItem
                  key={item.id}
                  active={!creating && item.id === selectedId}
                  icon={<MessageSquareText className="h-4 w-4" />}
                  title={item.title}
                  subtitle={contentSummary(item.content)}
                  onClick={() => selectItem(item)}
                />
              ))
            )}
          </ListPane>

          {/* 右：编辑区 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {creating || selected ? (
              <>
                <PageHeader
                  title={creating ? "新建提示词" : selected!.title}
                  icon={<MessageSquareText className="h-4 w-4" />}
                  subtitle={
                    creating
                      ? "保存后出现在左侧列表中"
                      : selected
                        ? `更新于 ${formatAssetTime(selected.updatedAt)}`
                        : undefined
                  }
                  actions={
                    <>
                      <Button
                        onClick={() => {
                          if (!form.content.trim()) return;
                          // 中心区可能停在文件 / 终端标签上：先切回对话，用户才看得到插入结果
                          useFileViewerStore.getState().activateTab(null);
                          usePromptInChat(form.content);
                          toast.success("已插入会话输入框");
                        }}
                        disabled={!form.content.trim()}
                        icon={<MessageSquare className="h-4 w-4" />}
                      >
                        在对话中使用
                      </Button>

                      <Button
                        onClick={() => void copyContent()}
                        disabled={!form.content.trim()}
                        icon={<ClipboardCopy className="h-4 w-4" />}
                      >
                        复制正文
                      </Button>

                      {!creating && selected && (
                        <ConfirmDeleteButton
                          onConfirm={() => void remove()}
                          title="删除提示词"
                        />
                      )}

                      <Button
                        variant="primary"
                        onClick={() => void save()}
                        loading={saving}
                        disabled={!canSave}
                      >
                        保存
                      </Button>
                    </>
                  }
                />

                {/* 正文占满剩余高度：页面本身不滚动，长文本在输入框内滚动 */}
                <PageBody scroll={false}>
                  <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4">
                    <Field label="标题" required className="shrink-0">
                      <TextInput
                        value={form.title}
                        maxLength={120}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            title: event.target.value,
                          }))
                        }
                        placeholder="例如：代码评审助手"
                      />
                    </Field>

                    <Field
                      label="标签"
                      hint="用于左侧筛选，最多 8 个；输入后按回车确认"
                      className="shrink-0"
                    >
                      <TagInput
                        value={form.tags}
                        suggestions={allTags}
                        onChange={(tags) =>
                          setForm((current) => ({ ...current, tags }))
                        }
                        placeholder="输入标签后回车"
                      />
                    </Field>

                    <Field
                      label="提示词正文"
                      required
                      className="flex min-h-0 flex-1 flex-col"
                    >
                      <TextArea
                        value={form.content}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            content: event.target.value,
                          }))
                        }
                        spellCheck={false}
                        placeholder="在这里写下提示词内容…"
                        className="min-h-0 flex-1 resize-none leading-relaxed"
                      />
                    </Field>

                    <div className="-mt-2 flex shrink-0 items-center justify-between text-meta text-text-muted">
                      <span>{form.content.length} 字符</span>
                      <span>Ctrl / ⌘ + S 保存</span>
                    </div>
                  </div>
                </PageBody>
              </>
            ) : (
              <EmptyPrompt onCreate={startCreate} />
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

/** 标签筛选 chip */
function TagChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 text-caption transition-colors ${
        active
          ? "border-accent/30 bg-accent-soft font-medium text-accent"
          : "border-border/60 bg-surface-2/40 text-text-secondary hover:border-border hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyPrompt({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      icon={<MessageSquareText />}
      title="管理常用提示词"
      description="把反复使用的提示词集中存下来，需要时一键复制。支持标题与标签。"
      action={
        <Button
          variant="primary"
          onClick={onCreate}
          icon={<Plus className="h-4 w-4" />}
        >
          新建提示词
        </Button>
      }
    />
  );
}
