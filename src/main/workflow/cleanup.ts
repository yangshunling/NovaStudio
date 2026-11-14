/**
 * 工作流 / 工作区的彻底删除
 *
 * 「删除」必须成套完成，不能只删主表留下孤儿：
 * 1. 运行事件、节点运行、运行主记录
 * 2. 节点运行对应的会话（含 CLI 侧数据与消息）
 * 3. 工作区里的 .novastudio 产物
 *
 * 节点会话的 CLI 文件（JSONL）已由 runner 在每次 attempt 结束时删除，
 * 这里的 releaseSession 只作为兜底，幂等且找不到文件时静默返回。
 * 员工资产（~/.novastudio/employee/<id>）与运行时（~/.novastudio/runtime/<id>）
 * 不随运行 / 工作流删除，只在删除员工时清理。
 *
 * 工作区本身（用户的项目文件夹）永远不删，只清理 Nova 生成的内容。
 */

import { existsSync } from "fs";
import { readdir, rm } from "fs/promises";
import { join } from "path";
import type { AgentService } from "../agents/agent-service";
import * as db from "../db/sqlite";
import { removeSessionRuntime } from "../sessions/runtime";
import type { Workflow } from "../../shared/types";

export interface CleanupDeps {
  service: AgentService;
}

/** 删除单个工作流的全部数据；返回是否需要继续清理工作区根目录 */
export async function deleteWorkflowData(
  workflow: Workflow,
  deps: CleanupDeps,
): Promise<void> {
  const { sessionIds } = db.deleteWorkflowRuns(workflow.id);

  // 先释放 CLI 侧会话数据（需要 session.configDir），再删索引行
  for (const sessionId of sessionIds) {
    await deps.service.releaseSession(sessionId);
    db.deleteSession(sessionId);
    // 运行时目录里可能带图片附件，随会话一起清理
    await removeSessionRuntime(sessionId);
  }

  db.deleteWorkflow(workflow.id);

  const project = db.getProject(workflow.workspaceId);
  if (project?.cwd) {
    await rm(
      join(project.cwd, ".novastudio", "workflows", workflow.id),
      { recursive: true, force: true },
    );
  }
}

/** 删除单次运行：数据库记录、节点会话、产物目录与运行时配置副本 */
export async function deleteRunData(
  runId: string,
  deps: CleanupDeps,
): Promise<boolean> {
  const { run, sessionIds } = db.deleteWorkflowRun(runId);
  if (!run) return false;

  for (const sessionId of sessionIds) {
    await deps.service.releaseSession(sessionId);
    db.deleteSession(sessionId);
    await removeSessionRuntime(sessionId);
  }

  await rm(run.artifactDir, { recursive: true, force: true }).catch(() => {});
  return true;
}

/**
 * 启动时清理异常退出遗留的工作流会话 JSONL。
 *
 * 正常路径下 attempt 结束就会删除；这里兜底崩溃 / 强制结束留下的文件。
 * 工作流会话不需要 CLI 文件，运行详情统一从 messages 表回放。
 */
export async function purgeStaleWorkflowSessionFiles(
  service: AgentService,
): Promise<void> {
  for (const sessionId of db.listWorkflowSessionIdsWithCliRef()) {
    await service.releaseSession(sessionId);
    db.clearSessionCliRef(sessionId);
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

  // 剩余的是普通聊天会话：先中断并等待运行收尾，再删项目（会话行级联删除）
  const projectSessionIds = db.listSessionIdsByProject(projectId);
  await deps.service.releaseProject(projectId);
  db.deleteProject(projectId);

  // 会话级运行时目录随会话一起清理；工作流会话没有这类目录，幂等
  await Promise.all(
    projectSessionIds.map((sessionId) => removeSessionRuntime(sessionId)),
  );

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
