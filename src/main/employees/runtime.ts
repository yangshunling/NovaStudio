/**
 * 数字员工运行时目录
 *
 * 员工在 DB 里只有一行记录与若干引用键；真正执行时才把引用还原成一套
 * Claude 专属配置目录，让 `CLAUDE_CONFIG_DIR` 指过去：
 *
 *   <DATA_DIR>/employee-runtime/<employeeId>/
 *     claude-home/                 ← CLAUDE_CONFIG_DIR
 *       settings.json              ← 从 ~/.claude/settings.json 同步
 *       .credentials.json          ← 从 ~/.claude/.credentials.json 同步（chmod 600）
 *       skills/                    ← 只放该员工勾选的技能目录
 *       projects/                  ← CLI 自己产生的会话 JSONL，--resume 的凭据
 *     mcp.json                     ← --mcp-config 指向这里，在 home 之外
 *     .nova-sync.json              ← 同步清单（技能目录指纹）
 *
 * 聊天与工作流共用这一套常驻目录：聊天在每次发送前同步，工作流在每个
 * attempt 开始前同步。工作流 attempt 结束时只删除该会话的 JSONL（运行
 * 详情从 messages 表回放），目录本身继续作为员工资产保留。
 *
 * 三条硬性规则：
 * 1. 运行时目录是派生品，可随时删除重建；唯一不可再生的是 projects/。
 * 2. 重同步只动 skills/，绝不清理 projects/。
 * 3. 执行前重新同步，避免员工配置 / 全局资产变化后仍用旧副本。
 */

import { existsSync } from "fs";
import { createHash } from "crypto";
import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "fs/promises";
import { join } from "path";
import type { DigitalEmployee } from "../../shared/types";
import { errorMessage } from "../../shared/error";
import { parseJsonSafe } from "../../shared/json";
import { DATA_DIR } from "../utils/paths";
import {
  claudeCredentialsPath,
  claudeSettingsPath,
} from "../agents/claude/config";
import { resolveEmployeeKnowledge } from "../knowledge/runtime";
import {
  resolveEmployeeMcpServers,
  resolveEmployeeSkills,
} from "./assets";

const RUNTIME_ROOT = join(DATA_DIR, "employee-runtime");
const SYNC_MANIFEST = ".nova-sync.json";

/** 员工 id 会参与路径拼接：只接受 UUID 这类安全字符 */
function assertEmployeeId(employeeId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(employeeId)) {
    throw new Error("非法数字员工 id");
  }
}

export function employeeRuntimeDir(employeeId: string): string {
  assertEmployeeId(employeeId);
  return join(RUNTIME_ROOT, employeeId);
}

export function employeeClaudeHome(employeeId: string): string {
  return join(employeeRuntimeDir(employeeId), "claude-home");
}

export function employeeMcpConfigPath(employeeId: string): string {
  return join(employeeRuntimeDir(employeeId), "mcp.json");
}

interface SyncManifest {
  version: number;
  /** skill 目录名 → 源目录指纹 */
  skills: Record<string, string>;
}

export interface EmployeeRuntimeSync {
  employeeId: string;
  configDir: string;
  mcpConfigPath: string;
  warnings: string[];
  injected: { mcpServers: string[]; skills: string[] };
}

/**
 * 同一员工的同步串行执行。
 *
 * 同一员工可能被多个会话同时使用；两个进程同时「先删后拷」同一个技能目录
 * 会留下半套文件。这里按员工排队，后到的等前一个完成再比对增量。
 */
const syncQueues = new Map<string, Promise<EmployeeRuntimeSync>>();

export function syncEmployeeRuntime(
  employee: DigitalEmployee,
): Promise<EmployeeRuntimeSync> {
  const previous = syncQueues.get(employee.id);
  const run = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => syncEmployeeRuntimeNow(employee));
  syncQueues.set(employee.id, run);
  void run
    .finally(() => {
      if (syncQueues.get(employee.id) === run) syncQueues.delete(employee.id);
    })
    .catch(() => {
      // 队列清理不参与错误传播；真正的错误由调用方 await 的 run 拿到
    });
  return run;
}

async function syncEmployeeRuntimeNow(
  employee: DigitalEmployee,
): Promise<EmployeeRuntimeSync> {
  const dir = employeeRuntimeDir(employee.id);
  const home = join(dir, "claude-home");
  const skillsDir = join(home, "skills");
  const mcpConfigPath = join(dir, "mcp.json");
  const manifestPath = join(dir, SYNC_MANIFEST);
  const warnings: string[] = [];

  await mkdir(skillsDir, { recursive: true });

  const manifest = await readManifest(manifestPath);

  // 1. settings / 凭证：只做 mtime 比对，变化才覆盖
  await syncFile(
    claudeSettingsPath(),
    join(home, "settings.json"),
    0o644,
    warnings,
    "未找到本机 Claude settings.json，员工会话将使用 Claude 内置默认配置。",
  );
  await syncFile(
    claudeCredentialsPath(),
    join(home, ".credentials.json"),
    0o600,
    warnings,
    "未找到本机 Claude 登录凭证，员工会话可能无法完成认证。",
  );

  // 2. skills：解绑立即删除；勾选的按源目录指纹增量复制
  const skills = resolveEmployeeSkills(employee);
  const expected = new Set(skills.map((skill) => skill.targetKey));
  for (const name of await safeReaddir(skillsDir)) {
    if (!expected.has(name)) {
      await rm(join(skillsDir, name), { recursive: true, force: true });
    }
  }

  const skillPrints: Record<string, string> = {};
  const injectedSkills: string[] = [];
  for (const skill of skills) {
    if (!existsSync(skill.source)) {
      warnings.push(
        `技能「${skill.name}」在本机 ~/.claude/skills 中不存在，已跳过。`,
      );
      continue;
    }

    const fingerprint = await fingerprintDir(skill.source);
    skillPrints[skill.targetKey] = fingerprint;
    const target = join(skillsDir, skill.targetKey);
    if (
      !existsSync(target) ||
      manifest.skills[skill.targetKey] !== fingerprint
    ) {
      // 先删后拷：cp -r 到已存在目录的行为不可靠，且要避免旧文件残留
      await rm(target, { recursive: true, force: true });
      await cp(skill.source, target, { recursive: true });
    }
    injectedSkills.push(skill.targetKey);
  }

  // 3. MCP：每次全量重写；空集也必须写，配合 --strict-mcp-config 阻断全局 MCP
  const servers = resolveEmployeeMcpServers(employee);
  const mcpServers: Record<string, unknown> = {};
  const injectedMcp: string[] = [];
  for (const server of servers) {
    if (!server.definition) {
      warnings.push(
        `MCP「${server.name}」在本机 Claude 配置中不存在，已跳过。`,
      );
      continue;
    }
    mcpServers[server.key] = server.definition;
    injectedMcp.push(server.key);
  }
  await writeFile(
    mcpConfigPath,
    `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    "utf8",
  );

  // 4. 指纹清单放在最后写：中途失败时下次仍会重新复制
  const nextManifest: SyncManifest = { version: 1, skills: skillPrints };
  await writeFile(
    manifestPath,
    `${JSON.stringify(nextManifest, null, 2)}\n`,
    "utf8",
  );

  return {
    employeeId: employee.id,
    configDir: home,
    mcpConfigPath,
    warnings,
    injected: { mcpServers: injectedMcp, skills: injectedSkills },
  };
}

/** 源文件存在且与目标不同（mtime / size）时才复制，并收紧权限 */
async function syncFile(
  source: string,
  target: string,
  mode: number,
  warnings: string[],
  missingHint: string,
): Promise<void> {
  if (!existsSync(source)) {
    warnings.push(missingHint);
    return;
  }
  try {
    const [from, to] = await Promise.all([
      stat(source),
      stat(target).catch(() => null),
    ]);
    if (to && to.mtimeMs === from.mtimeMs && to.size === from.size) return;
    await cp(source, target, { force: true });
    await chmod(target, mode).catch(() => {
      // Windows 下 chmod 基本无副作用；失败不影响运行
    });
  } catch (err) {
    warnings.push(`配置同步失败（${errorMessage(err)}），本次沿用旧副本。`);
  }
}

async function readManifest(path: string): Promise<SyncManifest> {
  try {
    const parsed = parseJsonSafe<Partial<SyncManifest>>(
      await readFile(path, "utf8"),
      {},
    );
    return {
      version: 1,
      skills:
        parsed.skills && typeof parsed.skills === "object"
          ? parsed.skills
          : {},
    };
  } catch {
    return { version: 1, skills: {} };
  }
}

/**
 * 目录指纹：递归收集相对路径 + 大小 + mtime，再哈希。
 *
 * 只看目录 mtime 无法感知深层文件内容变化（例如只改了 references/x.md），
 * 所以必须逐个文件记录。技能目录通常很小，开销可忽略。
 */
async function fingerprintDir(root: string): Promise<string> {
  const hash = createHash("sha1");

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // 依赖与版本库不属于技能内容，跳过可避免噪声与无限递归
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        hash.update(`L:${rel}\n`);
        continue;
      }
      if (entry.isDirectory()) {
        hash.update(`D:${rel}\n`);
        await walk(full, rel);
        continue;
      }
      try {
        const info = await stat(full);
        hash.update(`F:${rel}:${info.size}:${info.mtimeMs}\n`);
      } catch {
        // 遍历期间被删除的文件不参与指纹
      }
    }
  }

  await walk(root, "");
  return hash.digest("hex");
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** 删除员工的常驻运行时目录。凭证副本必须随员工一起清除。 */
export async function removeEmployeeRuntime(employeeId: string): Promise<void> {
  const dir = employeeRuntimeDir(employeeId);
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
    () => {
      // 删除失败不影响员工记录本身；下次同步会覆盖残留
    },
  );
  // 最后一个员工删除后顺手收掉空目录；还有其它员工时 rmdir 会失败
  await rmdir(RUNTIME_ROOT).catch(() => {});
}

// ============================================================================
// 聊天运行准备
// ============================================================================

export interface EmployeeChatPreparation {
  configDir: string;
  env: Record<string, string>;
  extraArgs: string[];
  systemPrompt: string;
  warnings: string[];
  injected: { mcpServers: string[]; skills: string[] };
}

/** 聊天用的系统提示词：身份 + 人设 + 知识库清单（不含工作流协作约定） */
export function composeEmployeeChatPrompt(
  employee: DigitalEmployee,
  knowledgeSection: string,
): string {
  return [
    employee.role
      ? `你是「${employee.name}」，职位：${employee.role}。`
      : `你是「${employee.name}」。`,
    employee.systemPrompt,
    knowledgeSection,
  ]
    .filter((part) => part && part.trim())
    .join("\n\n");
}

/**
 * 为一次聊天运行准备员工环境。
 *
 * 与工作流不同：这里使用员工常驻目录，CLI 会话 JSONL 落在
 * `claude-home/projects` 下，跨轮次与重启都能 --resume。
 */
export async function prepareEmployeeChatRun(
  employee: DigitalEmployee,
): Promise<EmployeeChatPreparation> {
  const sync = await syncEmployeeRuntime(employee);
  const knowledge = await resolveEmployeeKnowledge(employee.knowledgeBases);

  return {
    configDir: sync.configDir,
    env: { CLAUDE_CONFIG_DIR: sync.configDir },
    extraArgs: [
      "--mcp-config",
      sync.mcpConfigPath,
      "--strict-mcp-config",
    ],
    systemPrompt: composeEmployeeChatPrompt(employee, knowledge.promptSection),
    warnings: [...sync.warnings, ...knowledge.warnings],
    injected: sync.injected,
  };
}
