/**
 * 工作流运行 IPC
 *
 * 启动 / 查询 / 取消 / 人工审核 / 打开产物目录。
 * 运行状态与事件都已在引擎里落库，这里只做查询与转发。
 */

import { app, shell } from "electron";
import { readdir, stat } from "fs/promises";
import { join } from "path";
import * as db from "../../db/sqlite";
import type { Message, WorkflowArtifactFile } from "../../../shared/types";
import type { AgentService } from "../../agents/agent-service";
import type { WorkflowRunner } from "../../workflow/runner";
import { deleteRunData } from "../../workflow/cleanup";
import { readTextFileLimited } from "../../utils/fs";
import { resolveInsideReal } from "../../utils/paths";
import { handle } from "../register";
import { revealPath } from "../nativeUi";

/** 单文件读取上限：防止把超大日志整段塞进渲染层 */
const TEXT_LIMIT = 200_000;

async function readTextFile(path: string | null): Promise<string> {
  if (!path) return "";
  const snapshot = await readTextFileLimited(path, TEXT_LIMIT);
  if (!snapshot || snapshot.binary) return "";
  return snapshot.truncated
    ? `${snapshot.content}\n\n…（文件过大，已截断）`
    : snapshot.content;
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
    return revealPath(run.artifactDir);
  });

  handle("workflow:run:nodeDetail", async ({ runId, nodeRunId }) => {
    const nodeRun = db.getWorkflowNodeRun(nodeRunId);
    if (!nodeRun || nodeRun.runId !== runId) return null;

    const dir = nodeRun.artifactDir;

    // 每次调用（执行 / 重试 / 修改）一条记录；旧数据没有 attempt 行时回退到节点自身
    const attempts = db.listWorkflowNodeAttempts(nodeRun.id);
    const sources: Array<{
      attempt: number;
      round: number;
      kind: "initial" | "retry" | "revise";
      sessionId: string | null;
      userMessageId: string | null;
      assistantMessageId: string | null;
    }> =
      attempts.length > 0
        ? attempts
        : nodeRun.sessionId
          ? [
              {
                attempt: nodeRun.attempt,
                round: nodeRun.round,
                kind: nodeRun.attempt > 1 ? "retry" : "initial",
                sessionId: nodeRun.sessionId,
                userMessageId: null,
                assistantMessageId: null,
              },
            ]
          : [];

    // 人工要求修改复用同一个会话：整条消息只读一次，再按轮次的消息边界切分。
    const messageCache = new Map<string, Message[]>();
    const loadMessages = (sessionId: string): Message[] => {
      const cached = messageCache.get(sessionId);
      if (cached) return cached;
      const list = db.readSessionMessages(sessionId) ?? [];
      messageCache.set(sessionId, list);
      return list;
    };
    const roundMessages = (source: (typeof sources)[number]): Message[] => {
      if (!source.sessionId) return [];
      const all = loadMessages(source.sessionId);
      // 旧数据没有消息边界：只能回放整条会话
      if (!source.userMessageId) return all;
      const start = all.findIndex((item) => item.id === source.userMessageId);
      if (start < 0) return [];
      if (!source.assistantMessageId) return all.slice(start, start + 1);
      const end = all.findIndex(
        (item) => item.id === source.assistantMessageId,
      );
      return end >= start
        ? all.slice(start, end + 1)
        : all.slice(start, start + 1);
    };

    // 先取快照再做文件读取：读取期间事件还在追加，快照保持一致性
    const live = runner.liveTranscript(runId, nodeRun.id);

    return {
      execution: await readTextFile(nodeRun.inputPath),
      result: await readTextFile(nodeRun.outputPath),
      notices: db.listWorkflowNodeNotices(nodeRun.id),
      files: dir ? await listArtifactFiles(dir) : [],
      attempts: sources.map((source) => ({
        attempt: source.attempt,
        round: source.round,
        kind: source.kind,
        sessionId: source.sessionId,
        // 工作流会话的完整事件流在 messages 表里（含思考 / 工具调用 / 工具结果）
        messages: roundMessages(source),
      })),
      // 节点仍在执行时，数据库里只有用户消息；已产生的对话从运行器内存取
      live,
    };
  });

  handle("workflow:run:openNodeArtifacts", async ({ runId, nodeRunId }) => {
    const nodeRun = db.getWorkflowNodeRun(nodeRunId);
    if (!nodeRun || nodeRun.runId !== runId || !nodeRun.artifactDir) return false;
    return revealPath(nodeRun.artifactDir);
  });

  /** 在应用内读取产物文件（限定在节点产物目录内） */
  handle(
    "workflow:run:readNodeFile",
    async ({ runId, nodeRunId, relativePath }) => {
      const nodeRun = db.getWorkflowNodeRun(nodeRunId);
      if (!nodeRun || nodeRun.runId !== runId || !nodeRun.artifactDir) {
        return null;
      }
      const target = await resolveInsideReal(nodeRun.artifactDir, relativePath);
      if (!target) return null;
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
      const target = await resolveInsideReal(nodeRun.artifactDir, relativePath);
      if (!target) return false;
      const error = await shell.openPath(target);
      return !error;
    },
  );
}
