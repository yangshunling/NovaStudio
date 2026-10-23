/**
 * 工作流 / 工作区的彻底删除
 *
 * 「删除」必须成套完成，不能只删主表留下孤儿：
 * 1. 运行事件、节点运行、运行主记录
 * 2. 节点运行对应的会话（含 CLI 侧数据与消息）
 * 3. 工作区里的 .novastudio 产物
 * 4. 用户数据目录里的运行配置副本
 *
 * 工作区本身（用户的项目文件夹）永远不删，只清理 Nova 生成的内容。
 */

import { existsSync } from "fs";
import { readdir, rm } from "fs/promises";
import { join } from "path";
import type { AgentService } from "../engine/agent-service";
import * as db from "../db/sqlite";
import type { Workflow } from "../../shared/types";

export interface CleanupDeps {
  service: AgentService;
  userDataDir: string;
}

/** 删除单个工作流的全部数据；返回是否需要继续清理工作区根目录 */
export async function deleteWorkflowData(
  workflow: Workflow,
  deps: CleanupDeps,
): Promise<void> {
  const { runIds, sessionIds } = db.deleteWorkflowRuns(workflow.id);

  // 先释放 CLI 侧会话数据（需要 session.configDir），再删索引行
  for (const sessionId of sessionIds) {
    deps.service.releaseSession(sessionId);
    db.deleteSession(sessionId);
  }

  db.deleteWorkflow(workflow.id);

  const project = db.getProject(workflow.workspaceId);
  if (project?.cwd) {
    await rm(
      join(project.cwd, ".novastudio", "workflows", workflow.id),
      { recursive: true, force: true },
    );
  }

  // 每个运行的独立配置目录（含凭证副本、会话副本）
  for (const runId of runIds) {
    await rm(join(deps.userDataDir, "workflow-runs", runId), {
      recursive: true,
      force: true,
    });
  }
}

/** 删除工作区（复用项目实体）及其下所有工作流；返回被删工作流数量 */
export async function deleteWorkspaceData(
  projectId: string,
  deps: CleanupDeps,
): Promise<number> {
  const project = db.getProject(projectId);
  const workflows = db.listWorkflowsByWorkspace(projectId);

  for (const workflow of workflows) {
    await deleteWorkflowData(workflow, deps);
  }

  // 剩余的是普通聊天会话：统一释放 CLI 侧数据后删项目（会话行级联删除）
  deps.service.releaseProject(projectId);
  db.deleteProject(projectId);

  if (project?.cwd) {
    await removeWorkspaceArtifacts(project.cwd);
  }

  return workflows.length;
}

/**
 * 清理工作区内的 Nova 产物。
 * 只删 .novastudio/workflows；根目录里若只剩我们的 .gitignore，则一并移除。
 * 用户自己的文件与工作区目录本身保持不动。
 */
async function removeWorkspaceArtifacts(workspacePath: string): Promise<void> {
  const root = join(workspacePath, ".novastudio");
  await rm(join(root, "workflows"), { recursive: true, force: true });

  if (!existsSync(root)) return;
  try {
    const entries = await readdir(root);
    if (entries.every((name) => name === ".gitignore")) {
      await rm(root, { recursive: true, force: true });
    }
  } catch {
    // 目录不可读时保留，交给用户手动处理
  }
}
