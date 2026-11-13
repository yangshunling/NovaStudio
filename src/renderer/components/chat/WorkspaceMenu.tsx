/**
 * 工作区菜单 —— 输入框「指定工作区」下拉
 *
 * 候选集合、排序、行样式、键盘高亮与「管理工作区」入口只保留这一份实现：
 *
 *   解绑（仅已绑定时）→ 各工作区 → 管理工作区…
 *
 * 选择行为不在这里做：交给 lib/workspace-switch 的 switchWorkspace，
 * 确认文案与运行中拦截也由那里统一。
 */

import { useEffect, useState } from "react";
import { Check, Folder, FolderCog, FolderMinus } from "lucide-react";
import type { Project } from "@shared/types";
import { ipc } from "../../lib/ipc";
import { shortPath } from "../../lib/utils";
import { useChatStore } from "../../stores/chat";

export interface WorkspaceMenuItem {
  key: string;
  kind: "default" | "project" | "manage";
  /** 工作区 id；默认项 / 管理项为 null */
  id: string | null;
  name: string;
  /** 行内副标题（已压缩的短路径 / 说明） */
  detail: string;
  /** 完整路径，作为 tooltip */
  title?: string;
  current: boolean;
}

/** 未绑定工作区时实际使用的路径（主进程解析 defaultCwd / 主目录） */
export function useWorkspaceDefaultCwd(): string | null {
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ipc
      .getDefaultCwd()
      .then((cwd) => {
        if (alive) setDefaultCwd(cwd);
      })
      .catch(() => {
        // 取不到时退回「默认目录」文案，不影响选择
      });
    return () => {
      alive = false;
    };
  }, []);
  return defaultCwd;
}

export function buildWorkspaceItems({
  projects,
  currentProjectId,
  defaultCwd,
}: {
  projects: Project[];
  currentProjectId: string | null;
  defaultCwd: string | null;
}): WorkspaceMenuItem[] {
  const items: WorkspaceMenuItem[] = [];

  // 已绑定时才提供解绑入口，避免无意义的一行
  if (currentProjectId) {
    items.push({
      key: "workspace:none",
      kind: "default",
      id: null,
      name: "不使用工作区",
      detail: defaultCwd ? shortPath(defaultCwd) : "在默认目录中运行",
      title: defaultCwd ?? undefined,
      current: false,
    });
  }

  for (const project of projects) {
    items.push({
      key: `workspace:${project.id}`,
      kind: "project",
      id: project.id,
      name: project.name,
      detail: shortPath(project.cwd),
      title: project.cwd,
      current: project.id === currentProjectId,
    });
  }

  items.push({
    key: "workspace:manage",
    kind: "manage",
    id: null,
    name: "管理工作区…",
    detail: "新增 / 删除工作区",
    current: false,
  });

  return items;
}

/** 打开「工作区」页面；两条入口的「管理工作区…」都走这里 */
export function openWorkspaceManager(): void {
  useChatStore.getState().setViewMode("workspaces");
}

/** 行图标：解绑 / 工作区 / 管理 */
function ItemIcon({
  kind,
  current,
}: {
  kind: WorkspaceMenuItem["kind"];
  current: boolean;
}) {
  if (kind === "manage") {
    return <FolderCog className="h-4 w-4 shrink-0 text-text-muted" />;
  }
  if (kind === "default") {
    return <FolderMinus className="h-4 w-4 shrink-0 text-text-muted" />;
  }
  return (
    <Folder
      className={`h-4 w-4 shrink-0 ${
        current ? "text-accent" : "text-text-muted"
      }`}
    />
  );
}

export function WorkspaceMenuPanel({
  items,
  hoverIdx,
  emptyHint,
  headerLabel = "选择工作区",
  align = "left",
  onHover,
  onSelect,
  popupRef,
  itemRefs,
}: {
  items: WorkspaceMenuItem[];
  hoverIdx: number;
  emptyHint: string;
  headerLabel?: string;
  /** 弹窗向触发器哪一侧对齐 */
  align?: "left" | "right";
  onHover: (idx: number) => void;
  onSelect: (item: WorkspaceMenuItem) => void;
  popupRef?: React.Ref<HTMLDivElement>;
  itemRefs: React.MutableRefObject<(HTMLElement | null)[]>;
}) {
  /** 管理项固定在底部，不参与列表滚动，但共享同一套键盘索引 */
  const manageIndex = items.findIndex((item) => item.kind === "manage");
  const manage = manageIndex >= 0 ? items[manageIndex] : null;
  const listed = items.filter((item) => item.kind !== "manage");

  const renderRow = (item: WorkspaceMenuItem, index: number) => {
    const hovered = index === hoverIdx;
    return (
      <button
        key={item.key}
        ref={(el) => {
          itemRefs.current[index] = el;
        }}
        type="button"
        role="menuitem"
        aria-current={item.current ? "true" : undefined}
        onMouseEnter={() => onHover(index)}
        onClick={() => onSelect(item)}
        title={
          item.title ? `${item.name} · ${item.title}` : `${item.name} · ${item.detail}`
        }
        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
          hovered
            ? "bg-surface-hover text-text"
            : item.current
              ? "bg-surface-active text-text"
              : "text-text-secondary hover:bg-surface-hover hover:text-text"
        }`}
      >
        <ItemIcon kind={item.kind} current={item.current} />
        <span className="max-w-[55%] shrink-0 truncate ui-type-body font-medium">
          {item.name}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-text-muted ${
            item.kind === "manage" ? "ui-type-sub" : "ui-type-code-sm"
          }`}
        >
          {item.detail}
        </span>
        {item.current && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
      </button>
    );
  };

  return (
    <div
      ref={popupRef}
      role="menu"
      className={`ui-dropdown-in ui-ring absolute bottom-full z-50 mb-2 flex max-h-72 w-dropdown max-w-[calc(100vw-2rem)] flex-col rounded-xl bg-surface p-1.5 ${
        align === "right" ? "right-0" : "left-0"
      }`}
      style={{ boxShadow: "var(--c-shadow)" }}
    >
      <div className="flex items-center gap-1 px-2 pb-1 pt-0.5">
        <span className="min-w-0 flex-1 truncate ui-type-sub text-text-muted">
          {headerLabel}
        </span>
        <span className="shrink-0 ui-type-sub text-text-muted/70">
          ↑↓ 选择
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {listed.length === 0 ? (
          <div className="px-2.5 py-2 ui-type-note leading-relaxed text-text-muted">
            {emptyHint}
          </div>
        ) : (
          items.map((item, index) =>
            item.kind === "manage" ? null : renderRow(item, index),
          )
        )}
      </div>

      {manage && (
        <>
          <div className="my-1 h-px bg-border" />
          {renderRow(manage, manageIndex)}
        </>
      )}
    </div>
  );
}
