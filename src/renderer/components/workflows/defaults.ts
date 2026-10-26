/**
 * 工作流节点默认配置
 *
 * 新建节点与预置起止节点共用，保证画布上的每个节点都有完整的执行策略字段。
 * 默认取最保守的组合：失败即停 + 自动通过。
 */

import type { WorkflowNodeConfig } from "@shared/types";

export function defaultNodeConfig(): WorkflowNodeConfig {
  return {
    employeeId: null,
    agentId: null,
    taskDetail: "",
    failureStrategy: "stop",
    maxRetries: 1,
    reviewMode: "auto",
  };
}
