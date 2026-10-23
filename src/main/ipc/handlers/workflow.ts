/**
 * 工作流相关 IPC：列表 / 详情 / 新建 / 更新 / 删除
 *
 * 本层只做 CRUD 接线，画布数据（节点 / 连线）作为整份 JSON 存取，
 * 解析与校验责任在渲染进程，避免主进程理解 UI 布局细节。
 */

import { app } from "electron";
import type { AgentService } from "../../engine/agent-service";
import * as db from "../../db/sqlite";
import { deleteWorkflowData } from "../../workflow/cleanup";
import type { WorkflowRunner } from "../../workflow/runner";
import { handle } from "../register";

export function registerWorkflowHandlers(
  service: AgentService,
  runner: WorkflowRunner,
): void {
  handle("workflows:list", () => db.listWorkflows());

  handle("workflows:get", ({ id }) => db.getWorkflow(id));

  handle("workflows:create", ({ draft }) => db.createWorkflow(draft));

  handle("workflows:update", ({ id, draft }) => db.updateWorkflow(id, draft));

  handle("workflows:delete", async ({ id }) => {
    if (runner.hasActiveRunForWorkflow(id)) {
      throw new Error("该工作流正在运行，请先终止运行");
    }
    const workflow = db.getWorkflow(id);
    if (!workflow) return false;

    // 运行记录、节点会话、产物目录、配置副本一并删除
    await deleteWorkflowData(workflow, {
      service,
      userDataDir: app.getPath("userData"),
    });
    return true;
  });
}
