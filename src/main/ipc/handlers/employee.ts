/**
 * 数字员工相关 IPC：列表 / 新建 / 更新 / 删除
 *
 * 数字员工本质是一份「Agent 运行配置档案」：绑定现有 Agent，并附带
 * 头像、系统提示词、MCP 与技能等元数据。本层只做 CRUD，
 * 具体如何把这些配置注入运行时，由后续流程消费。
 */

import * as db from "../../db/sqlite";
import { handle } from "../register";

export function registerEmployeeHandlers(): void {
  handle("employees:list", () => db.listDigitalEmployees());

  handle("employees:create", ({ draft }) => db.createDigitalEmployee(draft));

  handle("employees:update", ({ id, draft }) => db.updateDigitalEmployee(id, draft));

  handle("employees:delete", ({ id }) => {
    db.deleteDigitalEmployee(id);
    return true;
  });
}
