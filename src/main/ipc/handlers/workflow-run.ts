/**
 * 工作流运行 IPC
 *
 * 启动 / 查询 / 取消 / 人工审核 / 打开产物目录。
 * 运行状态与事件都已在引擎里落库，这里只做查询与转发。
 */

import { shell } from "electron";
import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import * as db from "../../db/sqlite";
import type { WorkflowArtifactFile } from "../../../shared/types";
import type { WorkflowRunner } from "../../workflow/runner";
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

export function registerWorkflowRunHandlers(runner: WorkflowRunner): void {
  handle("workflow:run:start", ({ workflowId }) => runner.start(workflowId));

  handle("workflow:run:get", ({ runId }) => {
    const run = db.getWorkflowRun(runId);
    if (!run) return null;
    return {
      run,
      nodes: db.listWorkflowNodeRuns(runId),
      events: db.listWorkflowRunEvents(runId),
    };
  });

  handle("workflow:run:list", ({ workflowId }) =>
    db.listWorkflowRuns(workflowId),
  );

  handle("workflow:run:listByWorkspace", ({ workspaceId }) =>
    db.listWorkflowRunsByWorkspace(workspaceId),
  );

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
    return {
      input: await readTextFile(nodeRun.inputPath),
      systemPrompt: dir ? await readTextFile(join(dir, "system-prompt.md")) : "",
      output: await readTextFile(nodeRun.outputPath),
      handoff: await readTextFile(nodeRun.handoffPath),
      options: dir ? await readTextFile(join(dir, "agent-options.json")) : "",
      warnings: dir ? await readTextFile(join(dir, "warnings.txt")) : "",
      files: dir ? await listArtifactFiles(dir) : [],
    };
  });

  handle("workflow:run:openNodeArtifacts", async ({ runId, nodeRunId }) => {
    const nodeRun = db.getWorkflowNodeRun(nodeRunId);
    if (!nodeRun || nodeRun.runId !== runId || !nodeRun.artifactDir) return false;
    const error = await shell.openPath(nodeRun.artifactDir);
    return !error;
  });
}
