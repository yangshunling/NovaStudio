/**
 * 项目相关 IPC：列表 / 创建 / 删除
 */

import { existsSync, statSync } from "fs";
import type { AgentService } from "../../agents/agent-service";
import * as db from "../../db/sqlite";
import { readGitStatus } from "../../git/status";
import { deleteWorkspaceData } from "../../workflow/cleanup";
import type { WorkflowRunner } from "../../workflow/runner";
import { handle } from "../register";
import { revealPath } from "../nativeUi";

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

  handle("project:delete", async ({ id }) => {
    if (runner.hasActiveRunInWorkspace(id)) {
      throw new Error("该工作区有运行中的工作流，请先终止运行");
    }

    /*
     * 调度器只拾取 pending 任务。这里同步把它们置为失败，避免下面的清理
     * await 期间轮询器又为这个工作区创建新会话（随后被级联删除）。
     * 必须在第一个 await 之前完成。
     */
    for (const task of db.listAutomationTasks()) {
      if (task.projectId !== id || task.status !== "pending") continue;
      db.updateAutomationTask(task.id, {
        status: "failed",
        error: "工作区正在删除，任务已取消",
        completedAt: Date.now(),
      });
    }

    // 工作区 = 项目：会话、工作流、运行记录、产物、配置副本一起清理。
    // 清理期间占住工作区，避免触发器 / 另一个页面在此刻启动工作流。
    await runner.withMaintenance({ workspaceId: id }, () =>
      deleteWorkspaceData(id, { service }),
    );
    return true;
  });

  handle("project:reveal", async ({ id }) => {
    const project = db.getProject(id);
    if (!project) return false;
    return revealPath(project.cwd);
  });

  handle("project:gitStatus", ({ projectId }) => {
    const project = db.getProject(projectId);
    if (!project?.cwd) {
      return { available: false, branch: null, files: [] };
    }
    return readGitStatus(project.cwd);
  });

}
