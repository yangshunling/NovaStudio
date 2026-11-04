/**
 * 数字员工相关 IPC：列表 / 新建 / 更新 / 删除
 *
 * 数字员工本质是一份可复用的「人设 + 能力」档案：头像、系统提示词、
 * MCP 与技能等元数据。执行平台不落在员工上，而由引用它的工作流节点指定。
 * 本层只做 CRUD，具体如何把这些配置注入运行时，由后续流程消费。
 */

import * as db from "../../db/sqlite";
import { handle } from "../register";
import type { DigitalEmployeeDraft } from "../../../shared/types";

/** 主进程侧的最低校验：UI 之外也可能直接调用 IPC */
function normalizeDraft(draft: DigitalEmployeeDraft): DigitalEmployeeDraft {
  const name = draft.name.trim();
  if (!name) throw new Error("数字员工名称不能为空");
  if (name.length > 60) throw new Error("数字员工名称不能超过 60 个字符");
  return { ...draft, name };
}

/** 找出引用了该员工的工作流；被引用的员工不能直接删除 */
function findWorkflowsUsingEmployee(employeeId: string): string[] {
  return db
    .listWorkflows()
    .filter((workflow) =>
      workflow.graph.nodes.some(
        (node) => node.config.employeeId === employeeId,
      ),
    )
    .map((workflow) => workflow.name);
}

export function registerEmployeeHandlers(): void {
  handle("employees:list", () => db.listDigitalEmployees());

  handle("employees:create", ({ draft }) =>
    db.createDigitalEmployee(normalizeDraft(draft)),
  );

  handle("employees:update", ({ id, draft }) =>
    db.updateDigitalEmployee(id, normalizeDraft(draft)),
  );

  handle("employees:delete", ({ id }) => {
    const employee = db.getDigitalEmployee(id);
    if (!employee) return true;

    // 删除前必须确认没有工作流仍在使用：否则这些节点会在下次运行时
    // 直接报「员工不存在」，属于不可感知的静默故障。
    const workflows = findWorkflowsUsingEmployee(id);
    if (workflows.length > 0) {
      const shown = workflows.slice(0, 3).join("、");
      const rest = workflows.length > 3 ? ` 等 ${workflows.length} 个` : "";
      throw new Error(
        `无法删除：工作流「${shown}」${rest}正在使用该员工，请先在节点中解除绑定`,
      );
    }

    db.deleteDigitalEmployee(id);
    return true;
  });
}
