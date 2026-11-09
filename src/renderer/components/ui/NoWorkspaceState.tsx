/**
 * 没有工作区时的统一空态
 *
 * 工作流等依赖工作区的页面共用同一套样式与操作入口，
 * 避免各页面自行实现导致视觉与文案漂移。
 */

import { Folder, FolderKanban } from "lucide-react";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";

export function NoWorkspaceState({
  description,
  onManage,
}: {
  description: string;
  onManage: () => void;
}) {
  return (
    <EmptyState
      icon={<Folder />}
      title="还没有工作区"
      description={description}
      action={
        <Button
          variant="primary"
          icon={<FolderKanban className="h-4 w-4" />}
          onClick={onManage}
        >
          去管理工作区
        </Button>
      }
    />
  );
}
