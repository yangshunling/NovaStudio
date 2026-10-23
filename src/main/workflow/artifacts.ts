/**
 * 工作流产物与运行配置的物化
 *
 * 产物（用户可见、可追溯）落在工作区：
 *   <workspace>/.novastudio/workflows/<workflowId>/runs/<run>/nodes/<node>/attempt-N/
 *
 * Agent 的隔离配置（可能含凭证副本）落在应用数据目录，运行后删除凭证：
 *   <userData>/workflow-runs/<runId>/<node>-attempt-N/claude-home/
 */

import { cp, mkdir, rm, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";
import type { DigitalEmployee, EmployeeSkill } from "../../shared/types";

/** 一次运行在工作区里的产物根目录 */
export function createRunArtifactDir(
  workspacePath: string,
  workflowId: string,
  runId: string,
): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  return join(
    workspacePath,
    ".novastudio",
    "workflows",
    workflowId,
    "runs",
    `${stamp}_${runId.slice(0, 8)}`,
  );
}

/**
 * 初始化 .novastudio。
 *
 * 目录内部的 .gitignore 写 `*`：Git 会把整个目录视为全部忽略，
 * 不需要改动用户工作区根目录的 .gitignore。
 */
export async function ensureArtifactsRoot(workspacePath: string): Promise<void> {
  const root = join(workspacePath, ".novastudio");
  await mkdir(root, { recursive: true });
  const gitignore = join(root, ".gitignore");
  if (!existsSync(gitignore)) {
    await writeFile(gitignore, "*\n", "utf8");
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2));
}

/** 把长文本压到指定长度，供下游提示词使用 */
export function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n…（已截断）` : trimmed;
}

// ============================================================================
// Claude 隔离环境
// ============================================================================

export interface ClaudeEnvironment {
  /** 独立配置目录；null 表示凭证不可用，回退到用户默认目录 */
  configDir: string | null;
  /** 本次尝试的运行时目录（含 mcp.json 与 claude-home），结束后整体删除 */
  runtimeDir: string;
  /** 注入子进程的额外环境变量 */
  env?: Record<string, string>;
  mcpConfigPath?: string;
  warnings: string[];
}

/** 简单的参数拆分：支持单双引号，其余按空白切 */
function splitArgs(raw: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    result.push(match[1] ?? match[2] ?? match[3]);
  }
  return result;
}

/** 每行 KEY=VALUE；忽略空行与 # 注释 */
function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1);
  }
  return env;
}

function mcpJson(employee: DigitalEmployee): string {
  const servers: Record<string, unknown> = {};
  for (const server of employee.mcpServers) {
    if (!server.enabled || !server.command.trim()) continue;
    servers[server.name || server.id] = {
      command: server.command.trim(),
      args: splitArgs(server.args || ""),
      env: parseEnv(server.env || ""),
    };
  }
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

function safeSkillDirName(skill: EmployeeSkill): string {
  const base = (skill.name || skill.id).replace(/[\\/:*?"<>|\s]+/g, "-");
  return `${base}-${skill.id.slice(0, 8)}`;
}

/** 把员工启用的技能复制进独立配置目录 */
async function materializeSkills(
  configDir: string,
  workspacePath: string,
  employee: DigitalEmployee,
  warnings: string[],
): Promise<void> {
  const skillsRoot = join(configDir, "skills");
  await mkdir(skillsRoot, { recursive: true });

  for (const skill of employee.skills) {
    if (!skill.enabled || !skill.source.trim()) continue;
    const source = isAbsolute(skill.source)
      ? skill.source
      : join(workspacePath, skill.source);

    let info;
    try {
      info = await stat(source);
    } catch {
      warnings.push(`技能「${skill.name || skill.id}」的来源不存在：${skill.source}`);
      continue;
    }

    const target = join(skillsRoot, safeSkillDirName(skill));
    try {
      if (info.isDirectory()) {
        await cp(source, target, { recursive: true });
      } else {
        // 单个文件视为 SKILL.md
        await mkdir(target, { recursive: true });
        await cp(source, join(target, "SKILL.md"));
      }
    } catch (err) {
      warnings.push(
        `技能「${skill.name || skill.id}」复制失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * 为一次节点尝试准备 Claude 的隔离环境。
 *
 * 隔离的核心是 CLAUDE_CONFIG_DIR：每个节点尝试独立目录，互不读取对方的
 * settings / skills / agents / 会话历史。登录凭证从用户默认目录复制一份进来；
 * 找不到凭证时回退到默认配置目录并记录警告，避免直接把节点跑成“未登录”。
 */
export async function prepareClaudeEnvironment(input: {
  userDataDir: string;
  runId: string;
  nodeId: string;
  attempt: number;
  workspacePath: string;
  employee: DigitalEmployee;
}): Promise<ClaudeEnvironment> {
  const warnings: string[] = [];
  const runtimeDir = join(
    input.userDataDir,
    "workflow-runs",
    input.runId,
    `${input.nodeId}-attempt-${input.attempt}`,
  );
  const home = join(runtimeDir, "claude-home");
  await mkdir(home, { recursive: true });

  const credentials = join(homedir(), ".claude", ".credentials.json");
  const hasCredentials = existsSync(credentials);
  if (hasCredentials) {
    try {
      await cp(credentials, join(home, ".credentials.json"));
    } catch (err) {
      warnings.push(
        `登录凭证复制失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await materializeSkills(
      home,
      input.workspacePath,
      input.employee,
      warnings,
    );
  } else {
    warnings.push(
      "未找到 Claude 登录凭证，节点回退到用户默认配置目录，技能与设置将不隔离。",
    );
  }

  // mcp.json 含 MCP 的环境变量（Token/API Key），放在用户数据目录而不是工作区产物里
  const mcpConfigPath = join(runtimeDir, "mcp.json");
  await writeFile(mcpConfigPath, mcpJson(input.employee), "utf8");

  return {
    configDir: hasCredentials ? home : null,
    runtimeDir,
    env: hasCredentials ? { CLAUDE_CONFIG_DIR: home } : undefined,
    mcpConfigPath,
    warnings,
  };
}

/**
 * 运行结束后删除整个运行时目录。
 *
 * 包含凭证副本、mcp.json、技能副本和 CLI 会话文件；节点对话正文已由
 * agent-service 写入 SQLite，因此删掉 CLI 侧副本不影响运行详情回放。
 */
export async function removeClaudeRuntime(
  runtimeDir: string | null,
): Promise<void> {
  if (!runtimeDir) return;
  try {
    await rm(runtimeDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响运行结果
  }
}
