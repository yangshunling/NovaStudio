/**
 * 聊天区的跨组件事件
 *
 * 消息列表做了窗口化（只挂载最近 N 条），问题导航可能指向一条尚未挂载的
 * 消息。导航通过这个事件请求「展开到该消息」，消息列表收到后扩大窗口并滚动，
 * 避免把窗口化状态提升到 store 或层层传 props。
 */

export const REVEAL_MESSAGE_EVENT = "nova:reveal-message";

export function requestRevealMessage(id: string): void {
  window.dispatchEvent(
    new CustomEvent(REVEAL_MESSAGE_EVENT, { detail: { id } }),
  );
}

/**
 * 请求把焦点交给当前会话的输入框。
 *
 * 输入框的 ref 是 ChatArea 的私有 DOM，不提升到 store；
 * 会话列表只需要广播「用户点了某个会话」，由 ChatArea 自己决定聚焦时机。
 */
export const FOCUS_COMPOSER_EVENT = "nova:focus-composer";

export function requestComposerFocus(): void {
  window.dispatchEvent(new Event(FOCUS_COMPOSER_EVENT));
}

/**
 * 请求展开输入框旁的工作区选择器。
 *
 * 新建会话时先让用户决定这次在哪个目录里工作，避免先输入再切换
 * （已有内容时切换工作区还要二次确认）。菜单的展开状态是
 * ProjectSelector 的私有状态，因此同样用事件表达意图。
 */
export const OPEN_WORKSPACE_MENU_EVENT = "nova:open-workspace-menu";

export function requestWorkspaceMenu(): void {
  window.dispatchEvent(new Event(OPEN_WORKSPACE_MENU_EVENT));
}
