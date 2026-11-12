/**
 * 系统终端 IPC
 *
 * 终端进程运行在用户磁盘上，cwd 必须来自已登记的工作区：
 * 渲染层传入任意路径都会造成「在这个目录起一个 shell」的越权能力，
 * 因此这里以数据库里的工作区列表为准做一次校验。
 */

import * as db from "../../db/sqlite";
import type { TerminalManager } from "../../terminal/manager";
import { handle } from "../register";

/** 路径归一化：Windows 下大小写与分隔符都不敏感 */
function normalizePath(value: string): string {
  const trimmed = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** 校验 cwd 属于某个已登记的工作区；不存在时直接拒绝 */
function resolveWorkspaceCwd(cwd: string | undefined): string {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("终端工作目录未指定");
  }
  const target = normalizePath(cwd);
  const project = db
    .listProjects()
    .find((item) => normalizePath(item.cwd) === target);
  if (!project) {
    throw new Error("终端工作目录不属于任何已登记的工作区");
  }
  return project.cwd;
}

export function registerTerminalHandlers(terminals: TerminalManager): void {
  handle("terminal:create", ({ id, cwd, cols, rows }) => {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("终端标识无效");
    }
    return terminals.create(id, resolveWorkspaceCwd(cwd), cols, rows);
  });
  handle("terminal:write", ({ id, data }) => terminals.write(id, data));
  handle("terminal:resize", ({ id, cols, rows }) =>
    terminals.resize(id, cols, rows),
  );
  handle("terminal:kill", ({ id }) => terminals.kill(id));
}
