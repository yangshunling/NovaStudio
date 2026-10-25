/**
 * 工作流产物与运行配置的物化
 *
 * 产物（用户可见、可追溯）落在工作区：
 *   <workspace>/.novastudio/workflows/<workflowId>/runs/<run>/nodes/<node>/attempt-N/
 *
 * Agent 的隔离配置（可能含凭证副本）落在应用数据目录，运行后删除凭证：
 *   <userData>/workflow-runs/<runId>/<node>-attempt-N/claude-home/
 */

import { cp, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import type { DigitalEmployee } from "../../shared/types";
import {
  CLAUDE_CONNECTION_ENV_KEYS,
  claudeAuthMode,
  claudeOAuthCredentialsPath,
  claudeSettingsPath,
  materializeClaudeSettingsFile,
  type ClaudeAuthMode,
  type ClaudeConnection,
} from "../agents/claude/connection";
import { renderClaudeMcpConfig } from "../agents/claude/mcp";
import { materializeEmployeeSkills } from "../agents/claude/skills";

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
  /** 独立的配置目录；每个节点尝试一个，运行后整体删除 */
  configDir: string;
  /** 本次尝试的运行时目录（含 mcp.json 与 claude-home），结束后整体删除 */
  runtimeDir: string;
  /** 注入子进程的额外环境变量（现在只设置 CLAUDE_CONFIG_DIR） */
  env: Record<string, string>;
  /** 需要从宿主环境剔除的接入变量（防止覆盖节点配置文件） */
  envRemove: string[];
  /** 本次复制到隔离目录的标准配置文件来源 */
  settingsSource: string;
  mcpConfigPath?: string;
  /** 本次实际注入的 MCP 服务名 */
  mcpServers: string[];
  /** 本次实际物化到隔离目录的技能目录名 */
  skills: string[];
  /** 本次使用的认证方式，供运行审计展示 */
  authMode: ClaudeAuthMode;
  /** 是否复制了本机 OAuth 凭证副本 */
  oauthCopied: boolean;
  warnings: string[];
}

/**
 * 为一次节点尝试准备 Claude 的隔离环境。
 *
 * 与本机 Claude 彻底隔离：
 * - 配置目录永远是本次尝试新建的 claude-home，不读取 `~/.claude/settings.json`
 * - 接入信息来自「Agent 配置」保存时生成的标准 settings.json，执行时直接复制；
 *   宿主进程里的 ANTHROPIC_* 会被剔除，避免覆盖节点自己的文件
 * - 员工技能无论有没有登录凭证都会物化
 * - 唯一例外是 OAuth 登录：Nova 没有 API Key 时，复制一份 `.credentials.json`
 *   副本（只复制，不共享目录），否则节点无法认证
 */
export async function prepareClaudeEnvironment(input: {
  userDataDir: string;
  runId: string;
  nodeId: string;
  attempt: number;
  workspacePath: string;
  employee: DigitalEmployee;
  connection: ClaudeConnection;
  /** 本节点实际使用的模型；会覆盖复制文件里的 ANTHROPIC_MODEL */
  model: string;
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

  // 标准配置在保存时已经生成；这里只做复制。
  // 若文件被删除（例如用户手动清理），从数据库恢复一次。
  const settingsSource = claudeSettingsPath();
  if (!existsSync(settingsSource)) {
    warnings.push("标准配置文件缺失，已按当前连接重新生成。");
    materializeClaudeSettingsFile(input.connection);
  }
  const runtimeSettingsPath = join(home, "settings.json");
  await cp(settingsSource, runtimeSettingsPath);

  // Claude 的优先级是 settings.json.env > 环境变量 > --model。
  // 所以每个节点实际使用的模型必须写进这份**副本**，否则员工绑定的模型会被忽略。
  if (input.model) {
    let parsed: { env?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(await readFile(runtimeSettingsPath, "utf8")) as {
        env?: Record<string, unknown>;
      };
    } catch {
      parsed = {};
    }
    parsed.env = { ...(parsed.env ?? {}), ANTHROPIC_MODEL: input.model };
    await writeFile(
      runtimeSettingsPath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf8",
    );
  }

  // 只有走 OAuth 时才复制凭证；配置了 API Key 时不复制，
  // 避免两套认证方式同时存在导致 CLI 行为不确定
  let oauthCopied = false;
  if (!input.connection.apiKey) {
    const credentials = claudeOAuthCredentialsPath();
    if (existsSync(credentials)) {
      try {
        await cp(credentials, join(home, ".credentials.json"));
        oauthCopied = true;
        warnings.push(
          "Nova 未配置 API Key，已复制本机 OAuth 登录凭证作为本次运行的兜底。",
        );
      } catch (err) {
        warnings.push(
          `登录凭证复制失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      warnings.push(
        "Nova 未配置 API Key，且本机没有 Claude OAuth 凭证，节点可能无法通过认证。",
      );
    }
  }

  // 技能物化与 MCP 渲染互不依赖，并行准备；两者各自扫描自己的资产目录
  const [mcp, skills] = await Promise.all([
    renderClaudeMcpConfig(input.employee.mcpServers),
    materializeEmployeeSkills({
      configDir: home,
      workspacePath: input.workspacePath,
      skills: input.employee.skills,
      warnings,
    }),
  ]);
  warnings.push(...mcp.warnings);

  // mcp.json 含 MCP 的环境变量（Token/API Key），放在用户数据目录而不是工作区产物里
  const mcpConfigPath = join(runtimeDir, "mcp.json");
  await writeFile(mcpConfigPath, mcp.json, "utf8");

  return {
    configDir: home,
    runtimeDir,
    env: { CLAUDE_CONFIG_DIR: home },
    envRemove: [...CLAUDE_CONNECTION_ENV_KEYS],
    settingsSource,
    mcpConfigPath,
    mcpServers: mcp.servers,
    skills,
    authMode: claudeAuthMode(input.connection),
    oauthCopied,
    warnings,
  };
}

/** 异常退出遗留的运行目录保留上限：超过后下次启动清理 */
const RUNTIME_RETENTION_MS = 30 * 60 * 1000;

/**
 * 运行结束后删除整个运行时目录。
 *
 * 包含凭证副本、mcp.json、技能副本和 CLI 会话文件；节点对话正文已由
 * agent-service 写入 SQLite，因此删掉 CLI 侧副本不影响运行详情回放。
 *
 * Windows 上子进程可能尚未完全释放文件句柄，rm 会偶发失败，
 * 因此带上重试；删除 attempt 目录后再顺手移除空的 run 目录。
 */
export async function removeClaudeRuntime(
  runtimeDir: string | null,
): Promise<void> {
  if (!runtimeDir) return;
  try {
    await rm(runtimeDir, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 120,
    });
  } catch {
    // 清理失败不影响运行结果
  }

  // run 目录下还有其它节点的 attempt 时，rmdir 会失败并保留，符合预期
  try {
    await rmdir(dirname(runtimeDir));
  } catch {
    // 非空或已删除
  }
}

/**
 * 启动时清理异常退出遗留的运行配置目录。
 *
 * 只清理 30 分钟前的目录：正常运行的目录 mtime 很新，不会误删
 * （也为多实例启动留出安全边界）。凭证副本因此不会长期滞留。
 */
export async function purgeStaleWorkflowRuntimes(
  userDataDir: string,
): Promise<void> {
  const root = join(userDataDir, "workflow-runs");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const path = join(root, entry.name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs < RUNTIME_RETENTION_MS) return;
        await rm(path, {
          recursive: true,
          force: true,
          maxRetries: 4,
          retryDelay: 120,
        });
      } catch {
        // 单个目录清理失败不影响其它目录
      }
    }),
  );

  try {
    await rmdir(root);
  } catch {
    // 仍有活跃 / 新目录时保留
  }
}
