/**
 * 旧版 Nova 主库 → Claude 配置的一次性迁移
 *
 * 旧版本把 MCP / Skill 存在 `~/.novastudio/mcp`、`~/.novastudio/skills`。
 * 新版本统一以 Claude 配置为准：
 * - MCP 写入 `~/.claude.json` 顶层 mcpServers；
 * - Skill 复制到 `~/.claude/skills`；
 * - 员工的引用从 `library:<slug>` 重映射为 `claude-global:<key>`。
 *
 * 迁移是幂等的：旧目录被移到 `~/.novastudio/legacy-assets/<时间戳>` 后，
 * 后续启动不会再执行。冲突（Claude 已有同名条目）会跳过并保留旧数据。
 */

import { existsSync } from "fs";
import { cp, mkdir, readFile, readdir, rename, stat } from "fs/promises";
import { join } from "path";
import * as db from "../db/sqlite";
import {
  claudeSkillsDir,
  readClaudeMcpServers,
  writeClaudeMcpServers,
} from "../agents/claude/config";
import { DATA_DIR } from "../utils/paths";
import { copyFilter } from "../utils/fs";

const LEGACY_MCP_DIR = join(DATA_DIR, "mcp");
const LEGACY_SKILLS_DIR = join(DATA_DIR, "skills");
/** 旧版 Nova 自己维护的 Agent 连接配置目录（settings.json / models.json 等） */
const LEGACY_AGENT_CONFIG_DIR = join(DATA_DIR, "agent-connections");

interface LegacyMcpPayload {
  name?: unknown;
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function asRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

function toClaudeServer(payload: LegacyMcpPayload): Record<string, unknown> | null {
  const command = asString(payload.command);
  const url = asString(payload.url);
  const transport = asString(payload.transport);

  if (command) {
    return {
      command,
      args: asStringArray(payload.args),
      env: asRecord(payload.env),
    };
  }
  if (url) {
    return {
      type: transport === "sse" ? "sse" : "http",
      url,
      headers: asRecord(payload.headers),
    };
  }
  return null;
}

async function migrateMcp(): Promise<{
  mapBySlug: Map<string, string>;
}> {
  const mapBySlug = new Map<string, string>();
  if (!existsSync(LEGACY_MCP_DIR)) return { mapBySlug };

  let files: string[];
  try {
    files = await readdir(LEGACY_MCP_DIR);
  } catch {
    return { mapBySlug };
  }

  const servers = readClaudeMcpServers();
  let changed = false;

  for (const fileName of files) {
    if (!fileName.toLowerCase().endsWith(".json") || fileName.startsWith(".")) {
      continue;
    }
    const slug = fileName.replace(/\.json$/i, "");
    const path = join(LEGACY_MCP_DIR, fileName);

    let payload: LegacyMcpPayload;
    try {
      payload = JSON.parse(await readFile(path, "utf8")) as LegacyMcpPayload;
    } catch {
      continue;
    }

    const name = asString(payload.name).trim() || slug;
    if (Object.prototype.hasOwnProperty.call(servers, name)) {
      // Claude 已有同名条目：直接建立映射，但不把它标记为 Nova 创建
      mapBySlug.set(slug, name);
      continue;
    }

    const server = toClaudeServer(payload);
    if (!server) continue;

    servers[name] = server;
    changed = true;
    mapBySlug.set(slug, name);
    db.markManagedAsset("mcp", name);
  }

  if (changed) {
    writeClaudeMcpServers(servers);
  }
  return { mapBySlug };
}

async function migrateSkills(): Promise<{
  mapBySlug: Map<string, string>;
}> {
  const mapBySlug = new Map<string, string>();
  if (!existsSync(LEGACY_SKILLS_DIR)) return { mapBySlug };

  let dirs: string[];
  try {
    dirs = await readdir(LEGACY_SKILLS_DIR);
  } catch {
    return { mapBySlug };
  }

  const targetRoot = claudeSkillsDir();
  await mkdir(targetRoot, { recursive: true });

  for (const dirName of dirs) {
    if (dirName.startsWith(".")) continue;
    const source = join(LEGACY_SKILLS_DIR, dirName);
    let info;
    try {
      info = await stat(source);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    if (!existsSync(join(source, "SKILL.md"))) continue;

    const target = join(targetRoot, dirName);
    if (existsSync(target)) {
      mapBySlug.set(dirName, dirName);
      continue;
    }

    try {
      await cp(source, target, { recursive: true, filter: copyFilter });
      db.markManagedAsset("skill", dirName);
      mapBySlug.set(dirName, dirName);
    } catch {
      // 单个技能复制失败不影响其它技能
    }
  }

  return { mapBySlug };
}

function remapEmployeeRefs(
  mcpMapBySlug: Map<string, string>,
  skillMapBySlug: Map<string, string>,
): void {
  for (const employee of db.listDigitalEmployees()) {
    const mcpServers = employee.mcpServers.map((ref) => {
      if (!ref.assetId.startsWith("library:")) return ref;
      const slug = ref.assetId.slice("library:".length);
      const name = mcpMapBySlug.get(slug);
      return name
        ? { ...ref, assetId: `claude-global:${name}`, name }
        : ref;
    });

    const skills = employee.skills.map((ref) => {
      if (!ref.assetId.startsWith("library:")) return ref;
      const slug = ref.assetId.slice("library:".length);
      const name = skillMapBySlug.get(slug);
      return name
        ? { ...ref, assetId: `claude-global:${name}`, name: ref.name || name }
        : ref;
    });

    if (
      JSON.stringify(mcpServers) !== JSON.stringify(employee.mcpServers) ||
      JSON.stringify(skills) !== JSON.stringify(employee.skills)
    ) {
      db.updateEmployeeBindings(
        employee.id,
        JSON.stringify(mcpServers),
        JSON.stringify(skills),
      );
    }
  }
}

async function archiveLegacyDirs(): Promise<void> {
  const sources = [
    LEGACY_MCP_DIR,
    LEGACY_SKILLS_DIR,
    LEGACY_AGENT_CONFIG_DIR,
  ].filter((dir) => existsSync(dir));
  if (sources.length === 0) return;

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const archiveRoot = join(DATA_DIR, "legacy-assets", stamp);
  await mkdir(archiveRoot, { recursive: true });

  for (const source of sources) {
    const name =
      source === LEGACY_MCP_DIR
        ? "mcp"
        : source === LEGACY_SKILLS_DIR
          ? "skills"
          : "agent-connections";
    try {
      await rename(source, join(archiveRoot, name));
    } catch {
      // 归档失败时保留原目录，下一次启动仍会尝试迁移
    }
  }
}

/**
 * 执行迁移；任何异常都不会阻断应用启动。
 * 只有检测到旧目录时才做工作。
 */
export async function migrateLegacyAssets(): Promise<void> {
  const hasLegacy =
    existsSync(LEGACY_MCP_DIR) ||
    existsSync(LEGACY_SKILLS_DIR) ||
    existsSync(LEGACY_AGENT_CONFIG_DIR);
  if (!hasLegacy) return;

  try {
    const { mapBySlug: mcpMap } = await migrateMcp();
    const { mapBySlug: skillMap } = await migrateSkills();
    remapEmployeeRefs(mcpMap, skillMap);
    await archiveLegacyDirs();
    console.log(
      `[migration] legacy assets migrated: mcp=${mcpMap.size}, skills=${skillMap.size}`,
    );
  } catch (err) {
    console.warn(
      "[migration] legacy asset migration failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
