/**
 * 原生对话框 IPC
 */

import { dialog } from "electron";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { getMainWindow } from "../push";
import { handle } from "../register";
import type { FileEntry } from "@shared/types";

/** 忽略的目录名（常见构建产物 / 依赖 / VCS） */
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  "coverage",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
]);

/** 忽略的文件前缀 */
const IGNORE_FILE_PREFIXES = [".DS_Store"];

const MAX_ENTRIES = 200;

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

  handle("project:listFiles", async ({ cwd, subPath }) => {
    const target = subPath ? join(cwd, subPath) : cwd;
    let names: string[];
    try {
      names = await readdir(target);
    } catch {
      return [];
    }

    const entries: FileEntry[] = [];
    for (const name of names) {
      if (IGNORE_DIRS.has(name)) continue;
      if (IGNORE_FILE_PREFIXES.some((p) => name.startsWith(p))) continue;

      const fullPath = join(target, name);
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
  });
}
