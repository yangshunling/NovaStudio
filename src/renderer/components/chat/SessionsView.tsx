/**
 * 会话页 — 左侧扁平会话列表 + 右侧会话详情
 *
 * 会话不再按项目分组展示：新建会话即进入空白对话，需要读写本地文件时
 * 在输入框旁绑定项目（工作目录）。项目选择从「创建会话的前置步骤」
 * 变成「会话的可选上下文」，与主流 AI 客户端的心智保持一致。
 */

import { CenterPane } from "./CenterPane";
import { SessionListPanel } from "./SessionListPanel";

export function SessionsView() {
  return (
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="ui-page relative z-10 flex min-h-0 flex-1 overflow-hidden">
        <SessionListPanel />
        <CenterPane />
      </div>
    </div>
  );
}
