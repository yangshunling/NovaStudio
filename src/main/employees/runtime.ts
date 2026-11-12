/**
 * 数字员工运行时
 *
 * 员工在 DB 里只有一行记录与若干引用键，磁盘上只有一层：
 *
 *   <DATA_DIR>/runtime/<employeeId>/       ← CLI 运行时（派生品）
 *     claude-home/                         ← CLAUDE_CONFIG_DIR
 *       settings.json                      ← 从 ~/.claude 同步
 *       .credentials.json                  ← 从 ~/.claude 同步（chmod 600）
 *       skills/                            ← 员工勾选的技能（链接到 ~/.claude/skills）
 *       projects/                          ← CLI 会话 JSONL，--resume 的凭据
 *     mcp.json                             ← --mcp-config 指向这里
 *
 * 没有额外的「员工资产」中间目录：技能与 MCP 都从数据库里的定义直接投影到
 * 消费它的 home。聊天会话各自的 home 在 runtime/<sessionId>/employees/<id>/
 * 下，同样由 `projectEmployeeAssets` 投影。
 *
 * 两条硬性规则：
 * 1. 运行时可随时删除重建；唯一不可再生的是 projects/。
 * 2. 保存员工只写数据库，不碰磁盘；磁盘内容在下一次运行前按库重新生成。
 */

import { existsSync } from "fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "fs/promises";
import { dirname, join, resolve } from "path";
import type { DigitalEmployee } from "../../shared/types";
import { errorMessage } from "../../shared/error";
import { DATA_DIR } from "../utils/paths";
import {
  claudeCredentialsPath,
  claudeSettingsPath,
} from "../agents/claude/config";
import { getClaudeSettingsView } from "../agents/claude/settings";
import {
  resolveEmployeeMcpServers,
  resolveEmployeeSkills,
} from "./assets";

/** 运行时根目录：~/.novastudio/runtime/<employeeId>/ */
const RUNTIME_ROOT = join(DATA_DIR, "runtime");
/** 已废弃的员工资产目录：~/.novastudio/employee/<employeeId>/（仅迁移 / 清理） */
const LEGACY_ASSET_ROOT = join(DATA_DIR, "employee");
/** 更早版本的运行时目录：~/.novastudio/employee-runtime/<employeeId>/ */
const LEGACY_RUNTIME_ROOT = join(DATA_DIR, "employee-runtime");

function assertEmployeeId(employeeId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(employeeId)) {
    throw new Error(`非法员工 id: ${employeeId}`);
  }
}

/** 员工运行时根目录：~/.novastudio/runtime/<employeeId>/ */
export function employeeRuntimeDir(employeeId: string): string {
  assertEmployeeId(employeeId);
  return join(RUNTIME_ROOT, employeeId);
}

// ============================================================================
// 布局迁移
// ============================================================================

/**
 * 把旧布局搬迁到「只保留运行时」的布局。
 *
 * 需要兼容两种旧形态，它们的 `claude-home` 都要整体保留：
 * 1. <DATA_DIR>/employee/<id>/claude-home（已废弃的员工资产目录）
 * 2. <DATA_DIR>/employee-runtime/<id>/claude-home（更早的版本）
 *
 * `claude-home/projects` 是 --resume 的唯一凭据，迁移时必须整体保留。
 * 旧目录里的 skills / mcp.json 不再迁移：它们由数据库重新生成。
 */
async function migrateLegacyRuntime(employeeId: string): Promise<void> {
  const runtimeDir = employeeRuntimeDir(employeeId);
  const runtimeHome = join(runtimeDir, "claude-home");

  if (!existsSync(runtimeHome)) {
    const legacyHome = join(LEGACY_ASSET_ROOT, employeeId, "claude-home");
    const olderHome = join(LEGACY_RUNTIME_ROOT, employeeId, "claude-home");
    const source = existsSync(legacyHome)
      ? legacyHome
      : existsSync(olderHome)
        ? olderHome
        : null;

    if (source) {
      await mkdir(runtimeDir, { recursive: true });
      try {
        await rename(source, runtimeHome);
      } catch (err) {
        await cp(source, runtimeHome, { recursive: true, force: true });
        await rm(source, { recursive: true, force: true }).catch(() => {});
        console.warn(
          `[employee] 运行时目录迁移未完成（${errorMessage(err)}），已复制到 ${runtimeHome}`,
        );
      }
    }
  }

  // 旧目录整体废弃：里面的 skills / mcp.json 都是派生物，会重新生成
  await rm(join(LEGACY_ASSET_ROOT, employeeId), {
    recursive: true,
    force: true,
  }).catch(() => {});
  await rm(join(LEGACY_RUNTIME_ROOT, employeeId), {
    recursive: true,
    force: true,
  }).catch(() => {});
  await rmdir(LEGACY_ASSET_ROOT).catch(() => {});
  await rmdir(LEGACY_RUNTIME_ROOT).catch(() => {});
}

// ============================================================================
// 同步结果
// ============================================================================

/** 员工引用投影到某个 home 的结果 */
export interface EmployeeAssetProjection {
  warnings: string[];
  injected: { mcpServers: string[]; skills: string[] };
}

/** 运行时准备结果 */
export interface EmployeeRuntimeSync {
  employeeId: string;
  configDir: string;
  mcpConfigPath: string;
  warnings: string[];
  syncedAt: number;
  injected: { mcpServers: string[]; skills: string[] };
}

// ============================================================================
// 串行队列
// ============================================================================

/**
 * 同一员工的运行时同步串行执行。
 *
 * 工作流与聊天可能同时为同一个员工准备 home；后到的任务等前一个完成再执行，
 * 避免两边同时「先删后建」同一份技能链接。
 */
const syncQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(employeeId: string, task: () => Promise<T>): Promise<T> {
  const previous = syncQueues.get(employeeId);
  const run = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(task);
  syncQueues.set(employeeId, run);
  void run
    .finally(() => {
      if (syncQueues.get(employeeId) === run) syncQueues.delete(employeeId);
    })
    .catch(() => {
      // 队列清理不参与错误传播；真正的错误由调用方 await 的 run 拿到
    });
  return run;
}

/**
 * 确保员工目录是「只有运行时」的新布局。
 *
 * 聊天路径不走 `syncEmployeeRuntime`，但同样需要把旧版残留的
 * `employee/<id>` 迁移 / 清掉，否则只用聊天、从不跑工作流的员工会一直留着。
 * 与运行时同步共用同一条员工队列，避免并发删改。
 */
export function ensureEmployeeRuntimeLayout(employeeId: string): Promise<void> {
  return enqueue(employeeId, () => migrateLegacyRuntime(employeeId));
}

/** 准备 CLI 运行时（工作流 / 员工级共享 home） */
export function syncEmployeeRuntime(
  employee: DigitalEmployee,
): Promise<EmployeeRuntimeSync> {
  return enqueue(employee.id, async () => {
    await migrateLegacyRuntime(employee.id);

    const dir = employeeRuntimeDir(employee.id);
    const home = join(dir, "claude-home");
    const mcpConfigPath = join(dir, "mcp.json");
    const warnings: string[] = [];

    await mkdir(home, { recursive: true });

    // settings / 凭证：只做 mtime 比对，变化才覆盖
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
      // 已通过环境变量 / settings.json / apiKeyHelper 认证时，缺凭证文件是正常的
      hasClaudeAuth()
        ? ""
        : "未检测到 Claude 登录凭证或 API Key，员工会话可能无法完成认证。",
    );

    const projection = await projectEmployeeAssets(employee, {
      home,
      mcpConfigPath,
    });

    return {
      employeeId: employee.id,
      configDir: home,
      mcpConfigPath,
      warnings: [...warnings, ...projection.warnings],
      syncedAt: Date.now(),
      injected: projection.injected,
    };
  });
}

// ============================================================================
// 链接工具
// ============================================================================

function normalizePath(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 目标是否已经是指向指定源的链接（junction / symlink） */
export async function isLinkTo(path: string, target: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) return false;
    const [actual, expected] = await Promise.all([
      realpath(path),
      realpath(target),
    ]);
    return normalizePath(actual) === normalizePath(expected);
  } catch {
    return false;
  }
}

/** 路径是否是链接（用来清掉上一版留下的整目录链接） */
async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function createDirLink(
  target: string,
  path: string,
): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await symlink(
      resolve(target),
      path,
      process.platform === "win32" ? "junction" : "dir",
    );
    return true;
  } catch (err) {
    console.warn(
      `[employee] 无法创建链接 ${path} -> ${target}：${errorMessage(err)}`,
    );
    return false;
  }
}

/** 删除路径；链接只删链接本身，不会递归到目标目录 */
export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => {
    // 不存在或删除失败：交给下一次同步
  });
}

// ============================================================================
// 技能 / MCP 投影
// ============================================================================

/**
 * 把员工引用的技能与 MCP 直接投影到指定 home。
 *
 * 不再经过中间的「员工资产目录」：调用方传入最终消费目录，这里负责
 * 对齐文件内容。幂等，可反复执行。
 */
export async function projectEmployeeAssets(
  employee: DigitalEmployee,
  options: { home: string; mcpConfigPath: string },
): Promise<EmployeeAssetProjection> {
  const warnings: string[] = [];
  const skills = await projectSkills(
    employee,
    join(options.home, "skills"),
    warnings,
  );
  const mcpServers = await projectMcp(
    employee,
    options.mcpConfigPath,
    warnings,
  );

  return { warnings, injected: { skills, mcpServers } };
}

/** skills：解绑立即删除；勾选的优先建链接，失败时回退复制 */
async function projectSkills(
  employee: DigitalEmployee,
  skillsDir: string,
  warnings: string[],
): Promise<string[]> {
  // 上一版这里是指向员工资产目录的整目录链接，先拆掉再按技能逐个投影
  if (await isLink(skillsDir)) await removePath(skillsDir);
  await mkdir(skillsDir, { recursive: true });

  const skills = resolveEmployeeSkills(employee);
  const expected = new Set(skills.map((skill) => skill.targetKey));
  for (const name of await safeReaddir(skillsDir)) {
    // 链接和旧副本都用同一条安全删除路径
    if (!expected.has(name)) await removePath(join(skillsDir, name));
  }

  const injected: string[] = [];
  for (const skill of skills) {
    const target = join(skillsDir, skill.targetKey);

    if (!existsSync(skill.source)) {
      warnings.push(
        `技能「${skill.name}」在本机 ~/.claude/skills 中不存在，已跳过。`,
      );
      await removePath(target);
      continue;
    }

    if (!(await isLinkTo(target, skill.source))) {
      // 旧副本、失效链接或指向别处的链接：先移除再重建
      await removePath(target);
      if (!(await createDirLink(skill.source, target))) {
        // 跨盘 / 权限等原因无法建链：回退复制
        await cp(skill.source, target, { recursive: true, force: true });
        warnings.push(`技能「${skill.name}」无法创建链接，已复制副本。`);
      }
    }

    injected.push(skill.targetKey);
  }

  return injected;
}

/** MCP：每次全量重写；空集也必须写，配合 --strict-mcp-config 阻断全局 MCP */
async function projectMcp(
  employee: DigitalEmployee,
  mcpConfigPath: string,
  warnings: string[],
): Promise<string[]> {
  const servers = resolveEmployeeMcpServers(employee);
  const mcpServers: Record<string, unknown> = {};
  const injected: string[] = [];

  for (const server of servers) {
    if (!server.definition) {
      warnings.push(
        `MCP「${server.name}」在本机 Claude 配置中不存在，已跳过。`,
      );
      continue;
    }
    mcpServers[server.key] = server.definition;
    injected.push(server.key);
  }

  await mkdir(dirname(mcpConfigPath), { recursive: true });
  await writeFile(
    mcpConfigPath,
    `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    "utf8",
  );

  return injected;
}

// ============================================================================
// 基础配置同步
// ============================================================================

/** 源文件存在且与目标不同（mtime / size）时才复制，并收紧权限 */
async function syncFile(
  source: string,
  target: string,
  mode: number,
  warnings: string[],
  missingHint: string,
): Promise<void> {
  if (!existsSync(source)) {
    // 空 hint 表示该文件缺失是可接受的（例如认证来自环境变量 / settings.json）
    if (missingHint) warnings.push(missingHint);
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

/**
 * 把本机 Claude 的基础认证配置同步到任意会话 home。
 *
 * base-home 与员工 home 都需要 settings / 凭证；
 * 两者只差后续叠加的技能与 MCP。
 */
export async function syncClaudeBaseFiles(
  home: string,
  warnings: string[],
): Promise<void> {
  await syncFile(
    claudeSettingsPath(),
    join(home, "settings.json"),
    0o644,
    warnings,
    "未找到本机 Claude settings.json，会话将使用 Claude 内置默认配置。",
  );
  await syncFile(
    claudeCredentialsPath(),
    join(home, ".credentials.json"),
    0o600,
    warnings,
    hasClaudeAuth()
      ? ""
      : "未检测到 Claude 登录凭证或 API Key，会话可能无法完成认证。",
  );
}

// ============================================================================
// 工具函数
// ============================================================================

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * 本机是否已经有可用的 Claude 认证来源。
 *
 * 不能只看 ~/.claude/.credentials.json：
 * - 很多环境通过 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 认证（宿主环境变量会被 CLI 继承）
 * - settings.json 的 env 块或 apiKeyHelper 同样能完成认证
 *
 * 都没有时才提示缺凭证，避免“明明能登录却报错”的噪声。
 */
function hasClaudeAuth(): boolean {
  if (existsSync(claudeCredentialsPath())) return true;
  if (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    return true;
  }
  try {
    const view = getClaudeSettingsView();
    return view.hasApiKey || Boolean(view.apiKeyHelper);
  } catch {
    return false;
  }
}

// ============================================================================
// 对外生命周期
// ============================================================================

/** 删除员工的运行时目录；凭证副本必须随员工一起清除 */
export async function removeEmployeeRuntime(employeeId: string): Promise<void> {
  const dirs = [
    employeeRuntimeDir(employeeId),
    // 已废弃的资产目录 / 更早的运行时目录，一并清掉
    join(LEGACY_ASSET_ROOT, employeeId),
    join(LEGACY_RUNTIME_ROOT, employeeId),
  ];
  for (const dir of dirs) {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    }).catch(() => {
      // 删除失败不影响员工记录本身；下次同步会覆盖残留
    });
  }
  // 最后一个员工删除后顺手收掉空目录；还有其它员工时 rmdir 会失败
  await rmdir(RUNTIME_ROOT).catch(() => {});
  await rmdir(LEGACY_ASSET_ROOT).catch(() => {});
  await rmdir(LEGACY_RUNTIME_ROOT).catch(() => {});
}

// ============================================================================
// 系统提示词
// ============================================================================

/**
 * 聊天用的系统提示词：身份 + 人设 + 知识库清单（不含工作流协作约定）。
 *
 * 这段文字通过 `--append-system-prompt-file` 追加，Claude Code 自带的
 * “You are Claude Code” 身份依然存在。只写「你是 X」时，模型被问“你是谁”
 * 仍然会先自称 Claude，再补一句“被配置为 X”。因此这里必须显式声明：
 * 1. 员工名是唯一对外身份，不要自称 Claude / Claude Code / 通用助手；
 * 2. 会话可能有多位角色先后发言，其他角色的自我介绍不代表本轮身份。
 *
 * 底层模型 / 平台信息仍允许在被明确询问时如实说明，避免编造。
 */
export function composeEmployeeChatPrompt(
  employee: DigitalEmployee,
  knowledgeSection: string,
): string {
  const identity = employee.role
    ? `你是「${employee.name}」，职位：${employee.role}。`
    : `你是「${employee.name}」。`;

  const identityRule = [
    `「${employee.name}」是你的唯一对外身份。`,
    `当用户问「你是谁」「你能做什么」时，以「${employee.name}」的身份和职责回答，不要自称 Claude、Claude Code 或通用助手。`,
    "只有用户明确询问底层模型或运行平台时，才说明由 Claude Code 驱动，并给出实际模型名称。",
    "本会话可能由多位角色先后发言；其他角色的自我介绍与你无关，你始终是当前身份。",
    "上下文里每条用户消息都以「@回答者」开头，前缀只用于区分发言者，不是你回复的一部分；只有正文才是本轮任务。",
  ].join("");

  return [identity, identityRule, employee.systemPrompt, knowledgeSection]
    .filter((part) => part && part.trim())
    .join("\n\n");
}
