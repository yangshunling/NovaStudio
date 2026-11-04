/**
 * 工作流运行 IPC
 *
 * 启动 / 查询 / 取消 / 人工审核 / 打开产物目录。
 * 运行状态与事件都已在引擎里落库，这里只做查询与转发。
 */

import { app, shell } from "electron";
import { readFile, readdir, stat } from "fs/promises";
import { join, resolve, sep } from "path";
import * as db from "../../db/sqlite";
import type { WorkflowArtifactFile } from "../../../shared/types";
import type { AgentService } from "../../engine/agent-service";
import type { WorkflowRunner } from "../../workflow/runner";
import { deleteRunData } from "../../workflow/cleanup";
import { handle } from "../register";

/** 单文件读取上限：防止把超大日志整段塞进渲染层 */
const TEXT_LIMIT = 200_000;

async function readTextFile(path: string | null): Promise<string> {
  if (!path) return "";
  try {
    const buffer = await readFile(path);
    if (buffer.length <= TEXT_LIMIT) return buffer.toString("utf8");
    return `${buffer.subarray(0, TEXT_LIMIT).toString("utf8")}\n\n…（文件过大，已截断）`;
  } catch {
    return "";
  }
}

/** 列出节点产物目录（一层子目录），跳过含环境变量的 mcp.json */
async function listArtifactFiles(dir: string): Promise<WorkflowArtifactFile[]> {
  const files: WorkflowArtifactFile[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "mcp.json") continue;
      const full = join(dir, entry.name);

      if (entry.isFile()) {
        const info = await stat(full);
        files.push({ name: entry.name, relativePath: entry.name, size: info.size });
      } else if (entry.isDirectory()) {
        const children = await readdir(full, { withFileTypes: true });
        for (const child of children) {
          if (!child.isFile()) continue;
          const childPath = join(full, child.name);
          const info = await stat(childPath);
          files.push({
            name: child.name,
            relativePath: `${entry.name}/${child.name}`,
            size: info.size,
          });
        }
      }
    }
  } catch {
    // 目录不存在时返回空列表
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function registerWorkflowRunHandlers(
  service: AgentService,
  runner: WorkflowRunner,
): void {
  handle("workflow:run:start", ({ workflowId }) => runner.start(workflowId));

  handle("workflow:run:get", ({ runId }) => {
    const run = db.getWorkflowRun(runId);
    if (!run) return null;
    return {
      run,
      nodes: db.listWorkflowNodeRuns(runId),
    };
  });

  handle("workflow:run:list", ({ workflowId }) =>
    db.listWorkflowRuns(workflowId),
  );

  handle("workflow:run:listByWorkspace", ({ workspaceId }) =>
    db.listWorkflowRunsByWorkspace(workspaceId),
  );

  handle("workflow:run:listActive", () => db.listActiveWorkflowRuns());

  handle("workflow:run:resume", ({ runId, nodeRunId }) =>
    runner.resume(runId, nodeRunId),
  );

  handle("workflow:run:delete", async ({ runId }) => {
    const run = db.getWorkflowRun(runId);
    if (!run) return false;
    if (run.status === "running" || run.status === "awaiting_approval") {
      throw new Error("该运行正在执行，请先终止");
    }
    return deleteRunData(runId, {
      service,
      userDataDir: app.getPath("userData"),
    });
  });

  handle("workflow:run:cancel", ({ runId }) => runner.cancel(runId));

  handle("workflow:run:approve", ({ runId, nodeRunId, action, note }) =>
    runner.approve(runId, nodeRunId, action, note),
  );

  handle("workflow:run:openArtifacts", async ({ runId }) => {
    const run = db.getWorkflowRun(runId);
    if (!run) return false;
    const error = await shell.openPath(run.artifactDir);
    return !error;
  });

  handle("workflow:run:nodeDetail", async ({ runId, nodeRunId }) => {
    const nodeRun = db.getWorkflowNodeRun(nodeRunId);
    if (!nodeRun || nodeRun.runId !== runId) return null;

    const dir = nodeRun.artifactDir;

    // 每次尝试都是一个独立会话；旧数据没有 attempt 行时回退到节点自身
    const attempts = db.listWorkflowNodeAttempts(nodeRun.id);
    const sources =
      attempts.length > 0
        ? attempts
        : nodeRun.sessionId
          ? [{ attempt: nodeRun.attempt, sessionId: nodeRun.sessionId }]
          : [];

    // 先取快照再做文件读取：读取期间事件还在追加，快照保持一致性
    const live = runner.liveTranscript(runId, nodeRun.id);

    return {
      execution: await readTextFile(nodeRun.inputPath),
      result: await readTextFile(nodeRun.outputPath),
      notices: db.listWorkflowNodeNotices(nodeRun.id),
      files: dir ? await listArtifactFiles(dir) : [],
      attempts: sources.map(({ attempt, sessionId }) => ({
        attempt,
        sessionId,
        // 工作流会话的完整事件流在 messages 表里（含思考 / 工具调用 / 工具结果）
        messages: sessionId ? (db.readSessionMessages(sessionId) ?? []) : [],
      })),
      // 节点仍在执行时，数据库里只有用户消息；已产生的对话从运行器内存取
      live,
    };
  });

  handle("workflow:run:openNodeArtifacts", async ({ runId, nodeRunId }) => {
    const nodeRun = db.getWorkflowNodeRun(nodeRunId);
    if (!nodeRun || nodeRun.runId !== runId || !nodeRun.artifactDir) return false;
    const error = await shell.openPath(nodeRun.artifactDir);
    return !error;
  });

  /** 在应用内读取产物文件（限定在节点产物目录内） */
  handle(
    "workflow:run:readNodeFile",
    async ({ runId, nodeRunId, relativePath }) => {
      const nodeRun = db.getWorkflowNodeRun(nodeRunId);
      if (!nodeRun || nodeRun.runId !== runId || !nodeRun.artifactDir) {
        return null;
      }
      const root = resolve(nodeRun.artifactDir);
      const target = resolve(root, relativePath);
      if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
      const text = await readTextFile(target);
      return text || null;
    },
  );

  /** 打开节点产物目录里的单个文件；拒绝跳出产物目录的路径 */
  handle(
    "workflow:run:openNodeFile",
    async ({ runId, nodeRunId, relativePath }) => {
      const nodeRun = db.getWorkflowNodeRun(nodeRunId);
      if (!nodeRun || nodeRun.runId !== runId || !nodeRun.artifactDir) {
        return false;
      }
      const root = resolve(nodeRun.artifactDir);
      const target = resolve(root, relativePath);
      if (target !== root && !target.startsWith(`${root}${sep}`)) return false;
      const error = await shell.openPath(target);
      return !error;
    },
  );
}
