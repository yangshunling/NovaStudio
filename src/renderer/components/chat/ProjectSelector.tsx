/**
 * 工作区绑定器 — 输入框旁的工作目录选择器
 *
 * 项目不再作为会话的前置层级：新建会话后，用户在这里按需把会话绑定到一个
 * 本地文件夹。绑定后 Agent 在该目录运行，@ 提及与右侧工作区文件树也以它为根。
 *
 * 交互：
 *   - 点击触发器 → 向上展开工作区列表（输入框在底部，向下没有空间）
 *   - 选中工作区 = 绑定；「不使用工作区」= 解绑，回到默认目录
 *   - 工作区的新增 / 删除统一在「工作区」页面完成，这里只读取并选用
 *   - 已有消息的会话切换目录会重置 Agent 上下文（本地历史仍保留），执行前二次确认
 *
 * 列表复用 WorkspaceMenuPanel，与「管理工作区…」的条目、排序与样式保持一致。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Folder } from "lucide-react";
import { useChatStore } from "../../stores/chat";
import { switchWorkspace } from "../../lib/workspace-switch";
import {
  OPEN_WORKSPACE_MENU_EVENT,
  requestComposerFocus,
} from "../../lib/chat-events";
import {
  buildWorkspaceItems,
  useWorkspaceDefaultCwd,
  WorkspaceMenuPanel,
} from "./WorkspaceMenu";

export function ProjectSelector() {
  const projects = useChatStore((s) => s.projects);
  const currentProjectId = useChatStore((s) => s.currentProjectId);
  const setViewMode = useChatStore((s) => s.setViewMode);
  const defaultCwd = useWorkspaceDefaultCwd();

  const [open, setOpen] = useState(false);
  /** 键盘导航的当前高亮项 */
  const [hoverIdx, setHoverIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  const currentProject = projects.find((p) => p.id === currentProjectId);

  /**
   * 菜单项顺序：解绑（可选）→ 各工作区 → 管理工作区。
   * 键盘高亮与点击共用同一份索引，避免顺序漂移。
   */
  const menuItems = useMemo(
    () => buildWorkspaceItems({ projects, currentProjectId, defaultCwd }),
    [projects, currentProjectId, defaultCwd],
  );

  /** 绑定 / 切换 / 解绑。已开始的会话换目录前确认上下文重置 */
  const choose = async (projectId: string | null) => {
    setOpen(false);
    await switchWorkspace(projectId);
    // 选完工作区回到输入框：菜单已关闭，焦点不应留在消失的列表项上
    requestComposerFocus();
  };

  /** 工作区的登记与删除统一在「工作区」页面完成 */
  const manageWorkspaces = () => {
    setOpen(false);
    setViewMode("workspaces");
  };

  /** 打开时把高亮定位到当前绑定项，没有则从第一项开始 */
  const openMenu = () => {
    const index = menuItems.findIndex(
      (item) => item.kind === "project" && item.id === currentProjectId,
    );
    setHoverIdx(index >= 0 ? index : 0);
    setOpen(true);
  };

  /** 执行当前高亮项 */
  const activate = (index: number) => {
    const item = menuItems[index];
    if (!item) return;
    if (item.kind === "manage") manageWorkspaces();
    else void choose(item.id);
  };
  // 键盘监听只注册一次，但每次渲染都要拿到最新的 activate（项目列表可能变化）
  const activateRef = useRef(activate);
  activateRef.current = activate;

  /**
   * 新建会话时自动展开选择器：先选工作区，再开始输入。
   *
   * 打开动作延到下一帧，等 newSession 的渲染提交完成，
   * 这样 openMenu 读到的是「未绑定工作区」的新列表。
   * 焦点落在触发器上而不是输入框：菜单的 ↑↓ / Enter 是文档级监听，
   * 焦点在 textarea 时回车会被当成「选中菜单项」。选完 / 按 Esc 后
   * 再交还输入框（见 choose 与键盘监听里的 Escape）。
   */
  const openMenuRef = useRef(openMenu);
  openMenuRef.current = openMenu;
  useEffect(() => {
    const onRequest = () => {
      requestAnimationFrame(() => {
        openMenuRef.current();
        triggerRef.current?.focus();
      });
    };
    window.addEventListener(OPEN_WORKSPACE_MENU_EVENT, onRequest);
    return () =>
      window.removeEventListener(OPEN_WORKSPACE_MENU_EVENT, onRequest);
  }, []);

  // 展开时：外部点击关闭；↑↓ / Enter / Esc 键盘导航
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        // 放弃选择（含新建会话时的自动展开）后把焦点交还输入框
        requestComposerFocus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHoverIdx((i) => Math.min(i + 1, menuItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHoverIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        // 阻止聚焦在触发器上的按钮再触发一次 click（否则会先执行再切回关闭）
        e.preventDefault();
        activateRef.current(hoverIdx);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, menuItems.length, hoverIdx]);

  // 高亮项滚入可视区
  useEffect(() => {
    if (open) itemRefs.current[hoverIdx]?.scrollIntoView({ block: "nearest" });
  }, [hoverIdx, open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      {/* 触发器：绑定后显示项目名，未绑定显示引导文案 */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) setOpen(false);
          else openMenu();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) openMenu();
          }
        }}
        title={
          currentProject
            ? `工作目录：${currentProject.cwd}（切换会重置 AI 上下文）`
            : "为本次会话指定一个工作区（可选）"
        }
        aria-haspopup="menu"
        aria-expanded={open}
        className={`ui-toolbar-chip shrink-0 text-text-muted hover:bg-surface-hover hover:text-text ${
          open ? "bg-surface-hover text-text" : ""
        }`}
      >
        <Folder
          className={`h-icon-sm w-icon-sm shrink-0 ${
            currentProject ? "text-accent" : "text-text-muted"
          }`}
        />
        <span className="min-w-0 truncate text-left font-medium text-text">
          {currentProject?.name ?? "指定工作区"}
        </span>
        <ChevronDown
          className={`h-icon-sm w-icon-sm shrink-0 text-text-muted transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <WorkspaceMenuPanel
          /*
           * 与输入框左边缘对齐，而不是向右对齐触发器。
           * 向右对齐会让 22rem 的面板整体伸到输入框左侧，盖住会话列表。
           */
          align="left"
          items={menuItems}
          hoverIdx={hoverIdx}
          emptyHint="还没有工作区，先到「工作区」页面登记一个本地目录。"
          onHover={setHoverIdx}
          onSelect={(item) => {
            if (item.kind === "manage") manageWorkspaces();
            else void choose(item.id);
          }}
          itemRefs={itemRefs}
        />
      )}
    </div>
  );
}
