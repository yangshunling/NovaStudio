/**
 * 项目相关 IPC：列表 / 创建 / 删除
 */

import { app } from "electron";
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

  handle("project:create", ({ name, cwd }) => db.createProject(name, cwd));

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

  handle("project:gitStatus", ({ cwd }) => readGitStatus(cwd));
}
