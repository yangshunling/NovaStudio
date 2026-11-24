/**
 * 项目文件读取与系统打开
 */

import { shell } from "electron";
import { stat } from "node:fs/promises";
import type { OpenFileExternalResult } from "../../../shared/types";
import {
  readEmbeddedImage,
  readProjectFile,
  resolveProjectFile,
} from "../../files/access";
import { setWatchDirs } from "../../files/watcher";
import { handle } from "../register";
import { errorMessage } from "../../../shared/error";

export function registerFileHandlers(): void {
  handle("file:read", ({ projectId, relativePath }) =>
    readProjectFile(projectId, relativePath),
  );

  handle("file:readEmbeddedImage", ({ projectId, markdownPath, src }) =>
    readEmbeddedImage(projectId, markdownPath, src),
  );

  /** 文件面板声明需要监听的目录；主进程只监听这些目录，不做全树递归 */
  handle("workspace:watch", ({ projectId, dirs }) => setWatchDirs(projectId, dirs));

  /**
   * 删除工作区内的单个文件或文件夹。
   *
   * 路径由主进程重新解析并校验（realpath 后仍在项目根目录内），渲染层传参
   * 不作数；工作区根目录本身不可删除。文件夹按整棵子树处理，统一移入
   * 系统回收站 —— 误删时用户还能从回收站整体找回，比 unlink 递归删除安全。
   */
  handle("project:deleteFile", async ({ projectId, relativePath }) => {
    // 空路径会被解析成工作区根目录：删根目录等同清空整个工作区，直接拒绝
    if (!relativePath.trim()) throw new Error("不能删除工作区根目录");

    let fullPath: string;
    try {
      fullPath = await resolveProjectFile(projectId, relativePath);
    } catch (err) {
      // 目录树会把 Git 里已删除但尚未提交的路径画成占位行：它们没有实体
      if (errorMessage(err).includes("ENOENT")) {
        throw new Error("文件或文件夹已不存在");
      }
      throw err;
    }
    // realpath 已确认路径存在；stat 只用于区分「文件 / 目录」写提示文案
    const fileStat = await stat(fullPath);
    const target = fileStat.isDirectory() ? "文件夹" : "文件";
    try {
      await shell.trashItem(fullPath);
    } catch (err) {
      throw new Error(`无法删除${target}：${errorMessage(err)}`);
    }
    return true;
  });

  handle(
    "file:openExternal",
    async ({ projectId, relativePath }): Promise<OpenFileExternalResult> => {
      try {
        const fullPath = await resolveProjectFile(projectId, relativePath);
        const error = await shell.openPath(fullPath);
        return error ? { ok: false, error } : { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: errorMessage(err),
        };
      }
    },
  );
}
