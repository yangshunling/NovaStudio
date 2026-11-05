/**
 * IPC 层的原生 UI 小工具
 *
 * 文件选择框与「在系统文件管理器中打开」在多个 handler 里重复出现，
 * 统一在这里收敛取消语义与打开失败时的兜底行为。
 */

import { dialog, shell, type OpenDialogOptions } from "electron";
import { getMainWindow } from "./push";

/**
 * 弹出文件 / 目录选择框；用户取消时返回 null。
 * 窗口未就绪属于真正的错误，抛给 IPC 层而不是伪装成「取消」。
 */
export async function pickPaths(
  options: OpenDialogOptions,
): Promise<string[] | null> {
  const window = getMainWindow();
  if (!window) throw new Error("窗口未就绪");

  const result = await dialog.showOpenDialog(window, options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths;
}

/**
 * 用系统文件管理器打开路径。
 *
 * 目录不存在 / 没有默认打开方式时退回到「在文件夹中显示」，
 * 让用户至少能定位到目标位置。
 */
export async function revealPath(
  path: string | null | undefined,
): Promise<boolean> {
  if (!path) return false;
  const error = await shell.openPath(path);
  if (!error) return true;
  shell.showItemInFolder(path);
  return true;
}
