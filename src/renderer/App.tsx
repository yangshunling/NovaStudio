/**
 * Nova — 应用根组件
 *
 * 布局：
 * - 左侧 Sidebar：全局功能入口
 * - 右侧 SessionsView / AutomationView 等：按 viewMode 切换
 * - 会话页内部再分左右：扁平会话列表 + 对话区
 * - 设置弹框按需挂载
 *
 * 皮肤是横切关注点：这里不再把 themeId 往下传，需要皮肤信息的组件
 * 自行从 useTheme / useSkin 取值。
 */

import { useEffect, useState } from "react";
import { useChatStore } from "./stores/chat";
import { useFileViewerStore } from "./stores/fileViewer";
import { useTerminalStore } from "./stores/terminal";
import { useAutomationStore } from "./stores/automation";
import { preloadAssets } from "./stores/assets";
import { useAgentStream } from "./hooks/useAgentStream";
import { loadSkinSettings } from "./hooks/useTheme";
import { Sidebar } from "./components/app/Sidebar";
import { SessionsView } from "./components/chat/SessionsView";
import { AutomationView } from "./components/automation/AutomationView";
import { EmployeesView } from "./components/employees/EmployeesView";
import { AgentsView } from "./components/agents/AgentsView";
import { SkillsView } from "./components/skills/SkillsView";
import { McpView } from "./components/mcp/McpView";
import { KnowledgeView } from "./components/knowledge/KnowledgeView";
import { WorkspacesView } from "./components/workspaces/WorkspacesView";
import { WorkflowsView } from "./components/workflows/WorkflowsView";
import { TriggersView } from "./components/triggers/TriggersView";
import { TodosView } from "./components/todos/TodosView";
import { SettingsModal } from "./components/app/SettingsModal";
import { WorkspacePanel } from "./components/workspaces/WorkspacePanel";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { ToastViewport } from "./components/ui/ToastViewport";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { validateSkins } from "./skins/validate";

export default function App() {
  useAgentStream();

  const detectAgents = useChatStore((s) => s.detectAgents);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadProjects = useChatStore((s) => s.loadProjects);
  const viewMode = useChatStore((s) => s.viewMode);
  const showSettings = useChatStore((s) => s.showSettings);
  const showWorkspace = useChatStore((s) => s.showWorkspace);
  const projects = useChatStore((s) => s.projects);
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const terminals = useTerminalStore((s) => s.terminals);
  const loadTasks = useAutomationStore((s) => s.loadTasks);

  /** 终端标签激活时，右侧工作区面板跟随终端所属工作区 */
  const activeTerminal =
    terminals.find((tab) => tab.id === activeTabId) ?? null;
  const workspacePanelProject = activeTerminal
    ? (projects.find((project) => project.id === activeTerminal.workspaceId) ??
      null)
    : undefined;

  /**
   * 工作区页首次进入才挂载，之后常驻（切走只隐藏）。
   * 避免应用启动时就去扫描所有工作区目录，又能在切换页面后
   * 保留文件预览标签和 Git 提交草稿。
   */
  const [workspacesMounted, setWorkspacesMounted] = useState(false);

  useEffect(() => {
    // 开发期检查皮肤 token 完整性，避免新增皮肤时漏定义导致静默失效
    if (import.meta.env.DEV) validateSkins();

    detectAgents().catch((err) => {
      console.error("[nova] Agent 检测失败：", err);
    });
    void loadSkinSettings().catch((err) => {
      console.error("[nova] 皮肤设置加载失败：", err);
    });
    loadProjects()
      .then(() => loadSessions())
      .catch((err) => {
        console.error("[nova] 项目 / 会话加载失败：", err);
      });
    loadTasks().catch((err) => {
      console.error("[nova] 自动化任务加载失败：", err);
    });
    // 资产目录扫描一次即可：后续页面切换读缓存，外部变更由刷新按钮触发重扫
    preloadAssets();
  }, [detectAgents, loadProjects, loadSessions, loadTasks]);

  useEffect(() => {
    if (viewMode === "workspaces") setWorkspacesMounted(true);
  }, [viewMode]);

  return (
    <ErrorBoundary>
      <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
        <Sidebar />
        {viewMode === "todos" ? (
          <TodosView />
        ) : viewMode === "automation" ? (
          <AutomationView />
        ) : viewMode === "employees" ? (
          <EmployeesView />
        ) : viewMode === "skills" ? (
          <SkillsView />
        ) : viewMode === "mcp" ? (
          <McpView />
        ) : viewMode === "knowledge" ? (
          <KnowledgeView />
        ) : viewMode === "triggers" ? (
          <TriggersView />
        ) : viewMode === "agents" ? (
          <AgentsView />
        ) : null}

        {/*
          会话页常驻挂载：切换侧栏菜单时只隐藏、不卸载。
          否则 ChatArea 的输入草稿、@ 引用与滚动位置等局部状态会随卸载丢失。
          终端标签也挂在这里，因此切换侧栏页面不会重启 PTY。
        */}
        <div className={viewMode === "chat" ? "contents" : "hidden"}>
          <SessionsView />
          {showWorkspace && (
            <WorkspacePanel project={workspacePanelProject} />
          )}
        </div>
        {/*
          工作流页常驻挂载：编辑器的画布草稿、未保存状态、调试面板都是
          组件内部状态。切到别的侧栏再回来不应该把它们清空。
        */}
        <div className={viewMode === "workflow" ? "contents" : "hidden"}>
          <WorkflowsView />
        </div>

        {/*
          工作区页常驻挂载：文件预览标签、Git 提交草稿、选中的工作区
          都是组件内部状态。切到终端 / 会话再回来不应该被清空。
        */}
        {workspacesMounted && (
          <div className={viewMode === "workspaces" ? "contents" : "hidden"}>
            <WorkspacesView />
          </div>
        )}

        {showSettings && <SettingsModal />}
        {/* 全局确认框：替代 window.confirm，避免原生对话框抢走键盘焦点 */}
        <ConfirmDialog />
        {/* 全局提醒：顶部居中，所有页面共用同一套 */}
        <ToastViewport />
      </div>
    </ErrorBoundary>
  );
}
