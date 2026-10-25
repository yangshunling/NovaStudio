/**
 * Claude Code 本机配置读取 / 写入
 *
 * Nova 不再维护自己的 Agent 接入配置：
 * - 连接、登录、模型、全局 skills / plugins / CLAUDE.md 全部复用 `~/.claude`
 * - MCP 定义统一放在 Claude 用户配置 `~/.claude.json` 的 mcpServers 中
 *
 * 本模块只提供路径与 JSON 读写，不保存任何 Nova 私有副本。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/** Claude 配置根目录（Claude CLI 自身也认这个变量） */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Claude 全局 skills 目录 */
export function claudeSkillsDir(): string {
  return join(claudeConfigDir(), "skills");
}

/** Claude 全局 settings.json */
export function claudeSettingsPath(): string {
  return join(claudeConfigDir(), "settings.json");
}

/** Claude OAuth 凭证 */
export function claudeCredentialsPath(): string {
  return join(claudeConfigDir(), ".credentials.json");
}

/**
 * Claude 用户级配置文件（MCP 的 mcpServers 在这里）。
 * Claude 在设置 CLAUDE_CONFIG_DIR 时会把 .claude.json 放进该目录。
 */
export function claudeUserConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return configDir
    ? join(configDir, ".claude.json")
    : join(homedir(), ".claude.json");
}

export interface ClaudeUserConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readJsonObject(path: string): ClaudeUserConfig | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ClaudeUserConfig)
      : null;
  } catch {
    return null;
  }
}

/** 读取 `~/.claude.json`；文件不存在或格式错误时返回 null */
export function readClaudeUserConfig(): ClaudeUserConfig | null {
  return readJsonObject(claudeUserConfigPath());
}

/** 读取用户级 MCP 定义（顶层 mcpServers） */
export function readClaudeMcpServers(): Record<string, unknown> {
  const config = readClaudeUserConfig();
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return {};
  }
  return servers as Record<string, unknown>;
}

/**
 * 原子写入用户级 MCP 定义，保留 `~/.claude.json` 里的其它键。
 *
 * Claude Code 自己也会写这个文件，因此这里只做最小范围的读改写，
 * 并使用临时文件 + rename，避免写到一半损坏配置。
 */
export function writeClaudeMcpServers(
  next: Record<string, unknown>,
): void {
  const path = claudeUserConfigPath();
  const exists = existsSync(path);
  const current = readClaudeUserConfig();

  // 文件存在但无法解析时不能覆盖——那可能是用户其它重要配置
  if (exists && !current) {
    throw new Error(
      "~/.claude.json 无法解析，已拒绝写入；请先修复该文件后再试",
    );
  }

  const config = current ?? {};
  config.mcpServers = next;

  const temp = `${path}.nova-tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

/** 确保配置目录存在（用于写入前） */
export function ensureClaudeConfigDir(): void {
  const dir = dirname(claudeSettingsPath());
  if (!existsSync(dir)) {
    // 只创建 Claude 配置根目录；具体文件由 Claude CLI 自己维护
    mkdirSync(dir, { recursive: true });
  }
}
