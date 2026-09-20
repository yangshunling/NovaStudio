/**
 * 原生对话框 IPC
 */

import { dialog } from "electron";
import { getMainWindow } from "../push";
import { handle } from "../register";

export function registerDialogHandlers(): void {
  handle("dialog:pickDirectory", async () => {
    const window = getMainWindow();
    if (!window) return null;

    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"],
      title: "选择项目文件夹",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}
