/**
 * 运行参数面板 — 完全由当前 Agent 的 manifest.options 驱动
 *
 * 本组件不认识任何具体参数：字段从 Agent 的声明里读，值原样回传给主进程，
 * 由 provider 自己翻译成命令行开关。因此某个 Agent 增删自己的参数时，
 * 本文件无需改动。
 *
 * 语义约定：留空 = 不传该参数，由 CLI 自己决定；defaultValue 仅作占位提示。
 */

import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useChatStore, selectEffectiveAgentId } from "../stores/chat";
import { ModelSelect } from "./ui/ModelSelect";
import { Select } from "./ui/Select";

/** 无参数记录时的稳定空引用（避免 selector 每次返回新对象导致重渲染） */
const EMPTY_OPTIONS: Record<string, string> = Object.freeze({});

export function AgentOptionsMenu() {
  const agentId = useChatStore(selectEffectiveAgentId);
  const agents = useChatStore((s) => s.agents);
  const options = useChatStore((s) => s.optionValuesByAgent[agentId]) ?? EMPTY_OPTIONS;
  const setAgentOption = useChatStore((s) => s.setAgentOption);
  const clearAgentOptions = useChatStore((s) => s.clearAgentOptions);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 展开时：外部点击 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (rootRef.current?.contains(e.target as Node)) return;
      // Select 的选项浮层挂在 body 上，不算「面板外部」
      if (target?.closest?.("[data-nova-select-menu]")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const fields = agents.find((a) => a.id === agentId)?.options ?? [];
  // 该 Agent 没有声明任何参数：不渲染入口
  if (fields.length === 0) return null;

  const configured = fields.some((f) => options[f.key]);

  const controlClass =
    "ui-ring w-full rounded-lg bg-input-bg px-inset py-inset text-body text-text outline-none focus:border-input-border-focus";

  return (
    <div ref={rootRef} className="relative shrink-0">
      {open && (
        <div className="ui-dropdown-in ui-glass-strong ui-ring absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl p-card">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-meta font-medium text-text">运行参数</span>
            {configured && (
              <button
                type="button"
                onClick={() => clearAgentOptions(agentId)}
                className="text-caption text-text-muted transition-colors hover:text-text"
              >
                清空
              </button>
            )}
          </div>

          <div className="flex flex-col gap-3">
            {fields.map((field) => (
              <div key={field.key}>
                <span className="mb-1 block text-caption font-medium text-text-secondary">
                  {field.label}
                </span>

                {field.type === "select" ? (
                  <Select
                    value={options[field.key] ?? ""}
                    onChange={(value) => setAgentOption(agentId, field.key, value)}
                    className={controlClass}
                    options={[
                      {
                        value: "",
                        label: field.defaultValue
                          ? `默认（${field.defaultValue}）`
                          : "默认",
                      },
                      ...(field.choices ?? []).map((choice) => ({
                        value: choice,
                        label: choice,
                      })),
                    ]}
                  />
                ) : field.type === "model" ? (
                  <ModelSelect
                    agentId={agentId}
                    value={options[field.key] ?? ""}
                    onChange={(value) => setAgentOption(agentId, field.key, value)}
                  />
                ) : (
                  <input
                    value={options[field.key] ?? ""}
                    onChange={(e) => setAgentOption(agentId, field.key, e.target.value)}
                    placeholder={field.defaultValue ?? "默认"}
                    className={`${controlClass} placeholder-text-muted`}
                  />
                )}

                {field.hint && (
                  <span className="mt-1 block text-caption leading-relaxed text-text-muted">
                    {field.hint}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="运行参数"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`ui-btn-round ui-icon-action relative flex size-icon-btn items-center justify-center rounded-full ${
          open ? "text-accent" : ""
        }`}
      >
        <SlidersHorizontal className="h-4 w-4" />
        {/* 有已配置的参数时点一个提示点 */}
        {configured && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />
        )}
      </button>
    </div>
  );
}
