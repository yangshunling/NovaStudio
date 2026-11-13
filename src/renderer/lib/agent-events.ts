/**
 * Agent 配置的跨组件事件
 *
 * 会话页常驻挂载（切换侧栏只隐藏不卸载），因此「Agent 配置页保存了新的
 * 默认模型」不会让聊天工具栏重新挂载。保存成功后广播一次，由常驻组件
 * 自己刷新，避免工具栏长时间显示旧的默认模型名。
 */

export const AGENT_SETTINGS_CHANGED_EVENT = "nova:agent-settings-changed";

export function notifyAgentSettingsChanged(agentId: string): void {
  window.dispatchEvent(
    new CustomEvent(AGENT_SETTINGS_CHANGED_EVENT, { detail: { agentId } }),
  );
}
