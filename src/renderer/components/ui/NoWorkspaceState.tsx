/**
 * 没有工作区时的统一空态
 *
 * 工作流、终端管理等依赖工作区的页面共用同一套样式与操作入口，
 * 避免各页面自行实现导致视觉与文案漂移。
 */

import { Folder, FolderKanban } from "lucide-react";

export function NoWorkspaceState({
  description,
  onManage,
}: {
  description: string;
  onManage: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-24 text-center text-text-muted">
      <div className="ui-btn-round flex h-16 w-16 items-center justify-center rounded-2xl">
        <Folder className="h-6 w-6" />
      </div>
      <h2 className="ui-serif text-heading font-semibold text-text-secondary">
        还没有工作区
      </h2>
      <p className="text-body leading-relaxed">{description}</p>
      <button
        type="button"
        onClick={onManage}
        className="ui-btn-primary mt-2 flex items-center gap-1.5 rounded-full px-4 py-2 text-body font-medium active:scale-95"
      >
        <FolderKanban className="h-4 w-4" />
        去管理工作区
      </button>
    </div>
  );
}
