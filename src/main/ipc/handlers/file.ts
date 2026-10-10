/**
 * 项目文件读取与系统打开
 */

import { shell } from "electron";
import type { OpenFileExternalResult } from "../../../shared/types";
import { readProjectFile, resolveProjectFile } from "../../files/access";
import { handle } from "../register";

export function registerFileHandlers(): void {
  handle("file:read", ({ projectId, relativePath }) =>
    readProjectFile(projectId, relativePath),
  );

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
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
