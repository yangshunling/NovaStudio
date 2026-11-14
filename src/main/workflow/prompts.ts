/**
 * 工作流节点提示词构建
 *
 * 从 runner 中拆出的纯文本组装逻辑：
 * - 系统提示词：员工人设 + 知识库 + 工作流协作约定
 * - 首轮任务提示词：任务详情 + 上游产物摘要
 * - 人工要求修改时的增量提示词
 *
 * 只读运行快照与数据库，不触发任何 Agent / 文件写入，便于单独测试。
 */

import type { DigitalEmployee, WorkflowNode } from "../../shared/types";
import { BASE_CHAT_NAME } from "../agents/chat-identity";
import * as db from "../db/sqlite";

/** 构建提示词所需的最小运行快照，避免依赖 runner 内部类型 */
export interface WorkflowPromptRun {
  id: string;
  /** nodeId → 直接前驱 nodeId */
  predecessors: Map<string, string[]>;
  /** 完整计划顺序：用于把 nodeId 映射回节点名 */
  order: WorkflowNode[];
}

/**
 * 节点执行者的系统提示词。
 *
 * employee 为 null 表示节点选择了「通用助手」：没有员工人设 / 知识库，
 * 直接使用本机 Agent 全局配置，只需要身份边界与工作流协作约定。
 */
export function buildSystemPrompt(
  employee: DigitalEmployee | null,
  knowledgeSection: string,
): string {
  return [
    employee
      ? employee.role
        ? `你是「${employee.name}」，职位：${employee.role}。`
        : `你是「${employee.name}」。`
      : `你是「${BASE_CHAT_NAME}」，使用本机 Agent 的全局配置执行工作流节点。`,
    // 简介已从员工配置中移除，身份与职责统一由系统提示词表达
    employee?.systemPrompt ?? "",
    knowledgeSection,
    [
      "## 工作流协作约定",
      "你的最终回复会作为该节点的产物，交给下游节点使用。",
      "请只输出最终结论或交付物说明，不要重复分析过程；",
      "如果需要下游读取文件，请写出文件的完整路径。",
    ].join("\n"),
  ]
    .filter((part) => part && part.trim())
    .join("\n\n");
}

export function buildPrompt(
  active: WorkflowPromptRun,
  node: WorkflowNode,
): string {
  const parts: string[] = [];
  parts.push(
    node.config.taskDetail.trim() ||
      `请完成节点「${node.name}」分配给你的任务。`,
  );

  const upstreamIds = active.predecessors.get(node.id) ?? [];
  if (upstreamIds.length > 0) {
    // 一次取出全部节点运行记录，避免每个上游节点都查一遍数据库
    const nodeRuns = db.listWorkflowNodeRuns(active.id);
    const blocks = upstreamIds.map((predecessorId) => {
      const predecessor = active.order.find(
        (item) => item.id === predecessorId,
      );
      const nodeRun = nodeRuns.find((item) => item.nodeId === predecessorId);
      if (!nodeRun) return "";
      if (nodeRun.status === "skipped") {
        return `### 上游节点：${predecessor?.name ?? predecessorId}\n状态：已跳过，无产物。`;
      }
      return [
        `### 上游节点：${predecessor?.name ?? predecessorId}`,
        `状态：${nodeRun.status}`,
        nodeRun.outputPath ? `产物文件：${nodeRun.outputPath}` : "",
        nodeRun.artifactDir ? `产物目录：${nodeRun.artifactDir}` : "",
        nodeRun.outputSummary
          ? `输出摘要：\n${nodeRun.outputSummary}`
          : "输出摘要：无",
        "需要完整内容时，请直接读取上面的产物文件。",
      ]
        .filter(Boolean)
        .join("\n");
    });
    parts.push(`## 上游产物\n\n${blocks.filter(Boolean).join("\n\n")}`);
  }

  return parts.join("\n\n---\n\n");
}

/**
 * 人工要求修改时的输入。
 *
 * 复用同一个会话，因此不再重复上游产物与任务详情：Agent 上一轮已经看过。
 * 只把评审意见交给它，并要求直接产出最终版本。
 */
export function buildRevisionPrompt(feedback: string): string {
  const note = feedback.trim();
  return [
    "上一次输出未通过人工审核，请基于你上一次的产物直接修改，不要从头重做。",
    note ? `审核意见：${note}` : "审核人未填写具体意见，请自行复核并改进。",
    "修改完成后，只输出最终的完整版本。",
  ].join("\n\n");
}
