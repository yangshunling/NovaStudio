/**
 * 触发器 IPC：全局定义的增删改查 + 工作流绑定
 *
 * 定时执行本身由 ../workflow/trigger-scheduler 负责，本文件只处理用户操作。
 * 每次创建 / 更新都会重新计算下次触发时间：用户改完规则后不必等下一个轮询周期。
 */

import * as db from "../../db/sqlite";
import { handle } from "../register";
import {
  nextTriggerFireAt,
  normalizeTriggerSchedule,
} from "../../../shared/trigger-schedule";
import type { WorkflowTriggerDraft } from "../../../shared/types";

/** 标题必填；说明与规则统一清洗，避免把非法时间写进库 */
function normalizeDraft(draft: WorkflowTriggerDraft): WorkflowTriggerDraft {
  const title = draft.title.trim();
  if (!title) throw new Error("触发器标题不能为空");
  return {
    title,
    description: draft.description?.trim() ?? "",
    schedule: normalizeTriggerSchedule(draft.schedule),
    enabled: Boolean(draft.enabled),
  };
}

export function registerTriggerHandlers(): void {
  handle("triggers:list", () => db.listWorkflowTriggers());

  handle("triggers:create", ({ draft }) => {
    const normalized = normalizeDraft(draft);
    return db.createWorkflowTrigger(
      normalized,
      normalized.enabled ? nextTriggerFireAt(normalized.schedule) : null,
    );
  });

  handle("triggers:update", ({ id, draft }) => {
    const normalized = normalizeDraft(draft);
    return db.updateWorkflowTrigger(
      id,
      normalized,
      normalized.enabled ? nextTriggerFireAt(normalized.schedule) : null,
    );
  });

  handle("triggers:delete", ({ id }) => db.deleteWorkflowTrigger(id));

  handle("triggers:bindings", () => db.listWorkflowTriggerBindings());

  handle("triggers:bindingsForWorkflow", ({ workflowId }) =>
    db.listWorkflowTriggerIdsForWorkflow(workflowId),
  );

  handle("triggers:setForWorkflow", ({ workflowId, triggerIds }) => {
    if (!db.getWorkflow(workflowId)) return false;
    db.setWorkflowTriggers(workflowId, triggerIds);
    return true;
  });
}
