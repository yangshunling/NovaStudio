/**
 * VS Code 风格彩色文件夹图标。
 */

import { VscodeIcon } from "./VscodeIcon";
import { VSCODE_FILE_ICONS } from "./vscodeFileIcons";

export function FolderTypeIcon({
  open = false,
  size = 16,
  toneClassName = "text-accent",
  className = "",
}: {
  open?: boolean;
  size?: number;
  toneClassName?: string;
  className?: string;
}) {
  return (
    <VscodeIcon
      icon={
        VSCODE_FILE_ICONS[
          open ? "default-folder-opened" : "default-folder"
        ]
      }
      size={size}
      className={className}
    />
  );
}
