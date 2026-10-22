/**
 * 工作流相关 IPC：列表 / 详情 / 新建 / 更新 / 删除
 *
 * 本层只做 CRUD 接线，画布数据（节点 / 连线）作为整份 JSON 存取，
 * 解析与校验责任在渲染进程，避免主进程理解 UI 布局细节。
 */

import * as db from "../../db/sqlite";
import { handle } from "../register";

export function registerWorkflowHandlers(): void {
  handle("workflows:list", () => db.listWorkflows());

  handle("workflows:get", ({ id }) => db.getWorkflow(id));

  handle("workflows:create", ({ draft }) => db.createWorkflow(draft));

  handle("workflows:update", ({ id, draft }) => db.updateWorkflow(id, draft));

  handle("workflows:delete", ({ id }) => {
    db.deleteWorkflow(id);
    return true;
  });
}
