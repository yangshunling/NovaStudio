/**
 * 工作流节点的 Claude 运行准备
 *
 * 聊天与工作流共用同一套「员工常驻运行时」：
 *   <DATA_DIR>/employee-runtime/<employeeId>/
 *     claude-home/   ← CLAUDE_CONFIG_DIR
 *     mcp.json
 *
 * 工作流不再为每个执行尝试生成临时投影目录。同步是增量的（settings /
 * 凭证按 mtime，skills 按目录指纹），同一员工的多次同步会串行执行；
 * 详见 `employees/runtime.ts`。
 *
 * 同一 attempt 内的人工「要求修改」复用同一个 configDir，因此下一轮
 * 仍能靠 `--resume` 接上同一个 CLI 会话。attempt 结束后由 runner 删除
 * 该会话的 JSONL，目录本身作为员工环境继续保留。
 */

import type { AgentRunInput, PreparedAgentRun } from "../types";
import { syncEmployeeRuntime } from "../../employees/runtime";

export async function prepareClaudeWorkflowRun(
  input: AgentRunInput,
): Promise<PreparedAgentRun> {
  // 聊天由 agent:send 单独准备；这里只处理绑定了员工的工作流节点
  if (input.mode !== "workflow" || !input.employee) {
    return {};
  }

  const sync = await syncEmployeeRuntime(input.employee);

  return {
    configDir: sync.configDir,
    env: { CLAUDE_CONFIG_DIR: sync.configDir },
    extraArgs: [
      "--mcp-config",
      sync.mcpConfigPath,
      "--strict-mcp-config",
      /*
       * 不传 --no-session-persistence：人工审核「要求修改」需要在同一个
       * CLI 会话里续聊；会话文件由 runner 在该 attempt 结束时删除。
       */
    ],
    warnings: sync.warnings,
    injected: sync.injected,
  };
}
