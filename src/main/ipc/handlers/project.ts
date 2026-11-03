/**
 * 项目相关 IPC：列表 / 创建 / 删除
 */

import { app, shell } from "electron";
import { existsSync, statSync } from "fs";
import type { AgentService } from "../../engine/agent-service";
import * as db from "../../db/sqlite";
import { readGitStatus } from "../../git/status";
import { deleteWorkspaceData } from "../../workflow/cleanup";
import type { WorkflowRunner } from "../../workflow/runner";
import { handle } from "../register";

export function registerProjectHandlers(
  service: AgentService,
  runner: WorkflowRunner,
): void {
  handle("project:list", () => db.listProjects());

  handle("project:create", ({ name, cwd }) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("工作区名称不能为空");
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error("工作区目录不存在或不是文件夹");
    }

    const normalize = (value: string) =>
      value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const duplicate = db
      .listProjects()
      .find((project) => normalize(project.cwd) === normalize(cwd));
    if (duplicate) {
      throw new Error(`该目录已是工作区「${duplicate.name}」`);
    }

    return db.createProject(trimmed, cwd);
  });

  handle("project:update", ({ id, name }) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("工作区名称不能为空");
    return db.updateProjectName(id, trimmed);
  });

  handle("project:delete", async ({ id }) => {
    if (runner.hasActiveRunInWorkspace(id)) {
      throw new Error("该工作区有运行中的工作流，请先终止运行");
    }

    // 工作区 = 项目：会话、工作流、运行记录、产物、配置副本一起清理
    await deleteWorkspaceData(id, {
      service,
      userDataDir: app.getPath("userData"),
    });
    return true;
  });

  handle("project:reveal", async ({ id }) => {
    const project = db.getProject(id);
    if (!project) return false;
    // 目录存在时直接用系统文件管理器打开；失败则退回到「在文件夹中显示」
    const error = await shell.openPath(project.cwd);
    if (!error) return true;
    shell.showItemInFolder(project.cwd);
    return true;
  });

  handle("project:gitStatus", ({ projectId }) => {
    const project = db.getProject(projectId);
    if (!project?.cwd) {
      return { available: false, branch: null, files: [] };
    }
    return readGitStatus(project.cwd);
  });
}
