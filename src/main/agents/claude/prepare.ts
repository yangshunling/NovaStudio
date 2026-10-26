/**
 * 工作流节点的 Claude 运行准备
 *
 * 设计前提：
 * - MCP / Skill 的**定义**统一在 Claude 本机配置里，Nova 不再保存副本；
 * - 每个员工仍然可以选择自己要用的 MCP / Skill 子集；
 * - 为了让子集真正生效，节点运行时会生成一份**临时投影**：
 *     claude-home/settings.json   ← 复制 Claude 全局 settings.json
 *     claude-home/.credentials.json ← 复制 OAuth 凭证（如有）
 *     claude-home/skills/         ← 只复制该员工选中的 skill
 *   MCP 则通过 `--mcp-config` + `--strict-mcp-config` 精确指定。
 *
 * 临时目录位于 userData 的 workflow-runs 下，节点结束由宿主删除；
 * 它不是 Nova 维护的第二套配置，只是运行时的投影。
 */

import { existsSync } from "fs";
import { cp, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type {
  EmployeeMcpServer,
  EmployeeSkill,
} from "../../../shared/types";
import type { AgentRunInput, PreparedAgentRun } from "../types";
import {
  claudeCredentialsPath,
  claudeSettingsPath,
  claudeSkillsDir,
  readClaudeMcpServers,
} from "./config";

/** `claude-global:<key>` / `library:<key>` → `<key>` */
function stripOrigin(value: string): string {
  const index = value.indexOf(":");
  return index >= 0 ? value.slice(index + 1) : value;
}

function mcpKey(ref: EmployeeMcpServer): string {
  return stripOrigin(ref.assetId || ref.name || "").trim();
}

function skillKey(ref: EmployeeSkill): string {
  return stripOrigin(ref.assetId || ref.name || "").trim();
}

export async function prepareClaudeWorkflowRun(
  input: AgentRunInput,
): Promise<PreparedAgentRun> {
  // 聊天直接使用 Claude 本机配置，不做投影
  if (input.mode !== "workflow" || !input.employee || !input.runtimeDir) {
    return {};
  }

  const employee = input.employee;
  const warnings: string[] = [];

  const configDir = join(input.runtimeDir, "claude-home");
  const skillsDir = join(configDir, "skills");
  await mkdir(skillsDir, { recursive: true });

  // 1. 复制 Claude 全局连接配置与登录凭证
  const settingsSource = claudeSettingsPath();
  if (existsSync(settingsSource)) {
    await cp(settingsSource, join(configDir, "settings.json"));
  } else {
    warnings.push(
      "未找到本机 Claude settings.json，节点将使用 Claude 内置默认配置。",
    );
  }

  const credentialsSource = claudeCredentialsPath();
  if (existsSync(credentialsSource)) {
    await cp(credentialsSource, join(configDir, ".credentials.json"));
  }

  // 2. 只复制该员工选中的 skills
  const seenSkills = new Set<string>();
  for (const ref of employee.skills.filter((item) => item.enabled)) {
    const key = skillKey(ref);
    if (!key || seenSkills.has(key)) continue;
    seenSkills.add(key);

    const source = join(claudeSkillsDir(), key);
    if (!existsSync(source)) {
      warnings.push(
        `技能「${ref.name || key}」在本机 ~/.claude/skills 中不存在，已跳过。`,
      );
      continue;
    }
    await cp(source, join(skillsDir, key), { recursive: true });
  }

  // 3. 只把该员工选中的 MCP 交给 CLI；即使一个都没选也传空配置，
  //    配合 --strict-mcp-config 防止全局 MCP 意外泄漏给节点。
  const globalMcp = readClaudeMcpServers();
  const mcpServers: Record<string, unknown> = {};
  const seenMcp = new Set<string>();
  for (const ref of employee.mcpServers.filter((item) => item.enabled)) {
    const key = mcpKey(ref);
    if (!key || seenMcp.has(key)) continue;
    seenMcp.add(key);

    const definition = globalMcp[key];
    if (!definition) {
      warnings.push(
        `MCP「${ref.name || key}」在本机 Claude 配置中不存在，已跳过。`,
      );
      continue;
    }
    mcpServers[key] = definition;
  }

  const mcpConfigPath = join(input.runtimeDir, "mcp.json");
  await writeFile(
    mcpConfigPath,
    `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    "utf8",
  );

  return {
    configDir,
    env: { CLAUDE_CONFIG_DIR: configDir },
    extraArgs: [
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
      "--no-session-persistence",
    ],
    warnings,
  };
}
