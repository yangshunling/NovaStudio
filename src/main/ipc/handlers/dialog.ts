/**
 * 原生对话框 IPC
 */

import { readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { handle } from "../register";
import * as db from "../../db/sqlite";
import { resolveInsideReal } from "../../utils/paths";
import { isIgnoredName } from "../../files/ignore";
import { pickPaths } from "../nativeUi";
import type { FileEntry } from "@shared/types";

const MAX_ENTRIES = 200;

export function registerDialogHandlers(): void {
  handle("dialog:pickDirectory", async () => {
    const picked = await pickPaths({
      properties: ["openDirectory"],
      title: "选择项目文件夹",
    });
    return picked?.[0] ?? null;
  });

  handle(
    "project:listFiles",
    async ({ projectId, subPath }) => {
      const project = db.getProject(projectId);
      if (!project?.cwd) return [];

      let cwd: string;
      try {
        cwd = await realpath(project.cwd);
      } catch {
        return [];
      }

      // subPath 只能指向项目内部：渲染层传参不作数，必须再校验一次
      const target = await resolveInsideReal(cwd, subPath ?? "");
      if (!target) return [];

      let names: string[];
      try {
        names = await readdir(target);
      } catch {
        return [];
      }

      const entries: FileEntry[] = [];
      for (const name of names) {
        // .git / 依赖 / 构建目录 / 系统杂项文件都不进入文件树
        if (isIgnoredName(name)) continue;

        const fullPath = resolve(target, name);
        try {
          const s = await stat(fullPath);
          const rel = relative(cwd, fullPath).split(sep).join("/");
          entries.push({
            name,
            relativePath: rel,
            isDirectory: s.isDirectory(),
          });
        } catch {
          // 软链接 / 权限问题等：跳过
        }
        if (entries.length >= MAX_ENTRIES) break;
      }

      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return entries;
    },
  );
}
