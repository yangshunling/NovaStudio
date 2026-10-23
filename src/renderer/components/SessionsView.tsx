/**
 * 会话页 — 左侧项目 / 会话列表 + 右侧会话详情
 *
 * 项目不再挂在全局导航栏上：点击侧栏「新建会话」即可进入这里，
 * 左侧浏览项目与会话，右侧查看当前会话或开始新对话。
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
