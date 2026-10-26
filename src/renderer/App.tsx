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

import { useEffect } from "react";
import { useChatStore } from "./stores/chat";
import { useAutomationStore } from "./stores/automation";
import { useAgentStream } from "./hooks/useAgentStream";
import { loadSkinSettings } from "./hooks/useTheme";
import { Sidebar } from "./components/Sidebar";
import { SessionsView } from "./components/SessionsView";
import { AutomationView } from "./components/AutomationView";
import { EmployeesView } from "./components/employees/EmployeesView";
import { AgentsView } from "./components/agents/AgentsView";
import { SkillsView } from "./components/skills/SkillsView";
import { McpView } from "./components/mcp/McpView";
import { KnowledgeView } from "./components/knowledge/KnowledgeView";
import { WorkflowsView } from "./components/workflows/WorkflowsView";
import { TriggersView } from "./components/triggers/TriggersView";
import { SettingsModal } from "./components/SettingsModal";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { ToastViewport } from "./components/ui/ToastViewport";
import { validateSkins } from "./skins/validate";

export default function App() {
  useAgentStream();

  const detectAgents = useChatStore((s) => s.detectAgents);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadProjects = useChatStore((s) => s.loadProjects);
  const viewMode = useChatStore((s) => s.viewMode);
  const showSettings = useChatStore((s) => s.showSettings);
  const showWorkspace = useChatStore((s) => s.showWorkspace);
  const loadTasks = useAutomationStore((s) => s.loadTasks);

  useEffect(() => {
    // 开发期检查皮肤 token 完整性，避免新增皮肤时漏定义导致静默失效
    if (import.meta.env.DEV) validateSkins();

    detectAgents();
    void loadSkinSettings();
    loadProjects().then(() => loadSessions());
    loadTasks();
  }, [detectAgents, loadProjects, loadSessions, loadTasks]);

  return (
    <ErrorBoundary>
      <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
        <Sidebar />
        {viewMode === "automation" ? (
          <AutomationView />
        ) : viewMode === "employees" ? (
          <EmployeesView />
        ) : viewMode === "skills" ? (
          <SkillsView />
        ) : viewMode === "mcp" ? (
          <McpView />
        ) : viewMode === "knowledge" ? (
          <KnowledgeView />
        ) : viewMode === "workflow" ? (
          <WorkflowsView />
        ) : viewMode === "triggers" ? (
          <TriggersView />
        ) : viewMode === "agents" ? (
          <AgentsView />
        ) : (
          <>
            <SessionsView />
            {showWorkspace && <WorkspacePanel />}
          </>
        )}
        {showSettings && <SettingsModal />}
        {/* 全局提醒：顶部居中，所有页面共用同一套 */}
        <ToastViewport />
      </div>
    </ErrorBoundary>
  );
}
