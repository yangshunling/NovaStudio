/**
 * 会话页 — 左侧项目 / 会话列表 + 右侧会话详情
 *
 * 项目不再挂在全局导航栏上：点击侧栏「新建会话」即可进入这里，
 * 左侧浏览项目与会话，右侧查看当前会话或开始新对话。
 *
 * 没有项目时不显示左右分栏：直接铺一张与其它资产页一致的整页空态，
 * 避免左侧空列表 + 右侧空提示把版面切碎。
 */

import { FolderPlus } from "lucide-react";
import { dirName } from "../lib/utils";
import { useChatStore } from "../stores/chat";
import { CenterPane } from "./CenterPane";
import { SessionListPanel } from "./SessionListPanel";

export function SessionsView() {
  const projects = useChatStore((s) => s.projects);
  const pickDirectory = useChatStore((s) => s.pickDirectory);
  const createProject = useChatStore((s) => s.createProject);
  const selectProject = useChatStore((s) => s.selectProject);

  const handleCreateProject = async () => {
    const cwd = await pickDirectory();
    if (!cwd) return;

    const existing = projects.find((project) => project.cwd === cwd);
    if (existing) {
      selectProject(existing.id);
      return;
    }

    await createProject(dirName(cwd), cwd);
  };

  if (projects.length === 0) {
    return (
      <main className="relative flex flex-1 flex-col overflow-hidden">
        <div className="ui-page relative z-10 flex flex-1 flex-col overflow-hidden rounded-xl">
          <div className="m-auto flex max-w-lg flex-col items-center gap-3 px-6 py-20 text-center text-text-muted">
            <div className="ui-btn-round flex h-16 w-16 items-center justify-center rounded-2xl">
              <FolderPlus className="h-6 w-6" />
            </div>
            <h2 className="ui-serif text-heading font-semibold text-text-secondary">
              创建第一个项目
            </h2>
            <p className="text-body-lg leading-relaxed">
              选择一个本地文件夹作为工作目录。项目下的会话共享这个目录，
              工作流也会把它当作工作区。
            </p>
            <button
              type="button"
              onClick={() => void handleCreateProject()}
              className="ui-btn-primary mt-2 flex h-8 items-center gap-1.5 rounded-full px-4 text-body font-medium"
            >
              <FolderPlus className="h-4 w-4" />
              选择文件夹
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="ui-page relative z-10 flex min-h-0 flex-1 overflow-hidden">
        <SessionListPanel />
        <CenterPane />
      </div>
    </div>
  );
}
