/**
 * Nova — 应用根组件
 *
 * 布局：
 * - 左侧 Sidebar：项目 / 会话树 + Agent 选择
 * - 右侧 ChatArea 或 AutomationView：两者互斥
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
import { CenterPane } from "./components/CenterPane";
import { AutomationView } from "./components/AutomationView";
import { EmployeesView } from "./components/employees/EmployeesView";
import { SettingsModal } from "./components/SettingsModal";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
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
        ) : (
          <>
            <CenterPane />
            {showWorkspace && <WorkspacePanel />}
          </>
        )}
        {showSettings && <SettingsModal />}
      </div>
    </ErrorBoundary>
  );
}
