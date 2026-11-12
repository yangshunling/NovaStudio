/**
 * 会话级 Claude 运行时
 *
 * 一个会话 = 一份对话 + 多个可切换的 home：
 *
 *   <DATA_DIR>/runtime/sessions/<sessionId>/
 *     projects/                         ← 所有 home 共享的 CLI 会话 JSONL
 *     claude-home/                      ← 无员工时使用（base 环境）
 *       projects  -> ../../projects     （junction）
 *       settings.json / .credentials.json
 *       skills / plugins / agents / commands / output-styles -> ~/.claude/*
 *       CLAUDE.md
 *       mcp.json
 *     employees/<employeeId>/claude-home/   ← @ 员工时使用
 *       projects  -> ../../projects     （junction）
 *       settings.json / .credentials.json
 *       skills    -> 员工资产 skills
 *       mcp.json
 *
 * 发送消息时只切换 `CLAUDE_CONFIG_DIR`，对话始终落在同一个 projects 目录里，
 * 因此 `--resume` 能贯穿所有员工，实现共享上下文。
 */

import { existsSync } from "fs";
import { cp, mkdir, rm, rmdir, writeFile } from "fs/promises";
import { join } from "path";
import type { DigitalEmployee, Session } from "../../shared/types";
import { DATA_DIR } from "../utils/paths";
import {
  claudeConfigDir,
  readClaudeMcpServers,
} from "../agents/claude/config";
import { copySessionFileToProjects } from "../agents/claude/sessions";
import { resolveEmployeeKnowledge } from "../knowledge/runtime";
import {
  composeEmployeeChatPrompt,
  createDirLink,
  ensureEmployeeRuntimeLayout,
  isLinkTo,
  projectEmployeeAssets,
  removePath,
  syncClaudeBaseFiles,
} from "../employees/runtime";

/**
 * 会话运行时根目录：~/.novastudio/runtime/<sessionId>/
 *
 * 员工的工作流运行时也在同一根目录下（<employeeId>）。
 * 两者 id 都是 UUID，不会冲突；目录内容可以区分：
 * - 会话：claude-home/ + employees/ + projects/
 * - 员工：claude-home/ + mcp.json
 */
const RUNTIME_ROOT = join(DATA_DIR, "runtime");

/** base 环境需要镜像的全局目录；员工环境不镜像这些，保持隔离 */
const GLOBAL_DIRS = [
  "skills",
  "plugins",
  "agents",
  "commands",
  "output-styles",
] as const;

function assertSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error("非法会话 id");
  }
}

/** 会话运行时根目录 */
export function sessionRuntimeDir(sessionId: string): string {
  assertSessionId(sessionId);
  return join(RUNTIME_ROOT, sessionId);
}

/** 会话共享的 CLI projects 目录 */
export function sessionProjectsDir(sessionId: string): string {
  return join(sessionRuntimeDir(sessionId), "projects");
}

/** 无员工时使用的 base home */
export function sessionBaseHome(sessionId: string): string {
  return join(sessionRuntimeDir(sessionId), "claude-home");
}

/** @ 某个员工时使用的员工 home */
export function sessionEmployeeHome(
  sessionId: string,
  employeeId: string,
): string {
  assertSessionId(employeeId);
  return join(sessionRuntimeDir(sessionId), "employees", employeeId, "claude-home");
}

/**
 * 确保某个目录是指向目标的链接。
 *
 * projects 是会话共享的命脉，创建失败时必须让发送直接失败，
 * 而不是悄悄退化成各自独立的对话。
 */
async function ensureDirLink(
  target: string,
  path: string,
  warnings: string[],
  label: string,
  fatal = false,
): Promise<void> {
  if (await isLinkTo(path, target)) return;
  await removePath(path);
  if (await createDirLink(target, path)) return;
  if (fatal) throw new Error(`无法创建 ${label} 链接`);
  warnings.push(`无法创建 ${label} 链接，相关能力可能不可用。`);
}

/**
 * 创建会话的共享目录，并把旧会话的 JSONL 迁移进来。
 *
 * 老会话的 configDir 可能是 ~/.claude，也可能是旧的员工 runtime；
 * 只迁移一次，目标已存在时不会覆盖新产生的对话。
 */
async function ensureSessionRuntime(session: Session): Promise<void> {
  const projects = sessionProjectsDir(session.id);
  await mkdir(projects, { recursive: true });

  if (session.agentSessionId) {
    const copied = await copySessionFileToProjects(
      session.agentSessionId,
      session.cwd,
      session.configDir ?? null,
      projects,
    );
    if (!copied) {
      console.warn(
        `[session] 未找到旧会话文件，将开启新的 CLI 上下文：${session.id}`,
      );
    }
  }
}

/** base home：等同全局 Claude 环境 */
async function ensureBaseHome(
  session: Session,
): Promise<{ home: string; warnings: string[] }> {
  const home = sessionBaseHome(session.id);
  const warnings: string[] = [];

  await mkdir(home, { recursive: true });
  await ensureDirLink(
    sessionProjectsDir(session.id),
    join(home, "projects"),
    warnings,
    "会话 projects",
    true,
  );
  await syncClaudeBaseFiles(home, warnings);

  for (const name of GLOBAL_DIRS) {
    const source = join(claudeConfigDir(), name);
    if (!existsSync(source)) continue;
    await ensureDirLink(source, join(home, name), warnings, `全局 ${name}`);
  }

  const claudeMd = join(claudeConfigDir(), "CLAUDE.md");
  if (existsSync(claudeMd)) {
    await cp(claudeMd, join(home, "CLAUDE.md"), { force: true });
  }

  // 全局 MCP 写入 base home；base 轮次不传 --strict-mcp-config，
  // 项目级 .mcp.json 仍然会正常加载
  await writeFile(
    join(home, "mcp.json"),
    `${JSON.stringify({ mcpServers: readClaudeMcpServers() }, null, 2)}\n`,
    "utf8",
  );

  return { home, warnings };
}

/** 员工 home：只叠加员工技能 / MCP，保持隔离 */
async function ensureEmployeeHome(
  session: Session,
  employee: DigitalEmployee,
): Promise<{ home: string; warnings: string[] }> {
  const home = sessionEmployeeHome(session.id, employee.id);
  const warnings: string[] = [];

  // 顺手清掉旧版留下的 employee/<id> 资产目录（幂等）
  await ensureEmployeeRuntimeLayout(employee.id);

  await mkdir(home, { recursive: true });
  await ensureDirLink(
    sessionProjectsDir(session.id),
    join(home, "projects"),
    warnings,
    "会话 projects",
    true,
  );
  await syncClaudeBaseFiles(home, warnings);

  /*
   * 技能与 MCP 直接按数据库里的定义投影到本会话的 home。
   * 不再经过共享的「员工资产目录」：每个会话有自己的技能链接与 mcp.json，
   * 互相之间不共享可变文件。
   */
  const projection = await projectEmployeeAssets(employee, {
    home,
    mcpConfigPath: join(home, "mcp.json"),
  });
  warnings.push(...projection.warnings);

  return { home, warnings };
}

/**
 * 通用助手的系统提示词。
 *
 * 它不是数字员工，但会话可能刚由某位员工发言过：
 * 共享上下文里留着对方“我是某某”的自我介绍，没有这层约束时，
 * 通用助手很容易顺着继续扮演上一位员工。这里只做身份边界，
 * 不改任何模型 / 工具行为。
 */
export const BASE_CHAT_NAME = "通用助手";

const BASE_CHAT_PROMPT = [
  `你是「${BASE_CHAT_NAME}」，使用本机 Claude Code 的全局配置回答。`,
  "本会话可能由多位数字员工先后发言；他们的自我介绍不代表你，不要沿用其他角色的身份或职责。",
  "上下文里每条用户消息都以「@回答者」开头；前缀只用于区分发言者，不是你回复的一部分。",
  `当用户问「你是谁」时，以「${BASE_CHAT_NAME}」自称；只有被明确询问底层模型或运行平台时，才说明由 Claude Code 驱动。`,
].join("");

export interface SessionChatPreparation {
  /** 本轮使用的 CLAUDE_CONFIG_DIR */
  configDir: string;
  extraArgs: string[];
  /** 员工人设 + 知识库；base 轮次为空 */
  systemPrompt?: string;
  warnings: string[];
}

/**
 * 同一会话的运行时准备串行执行。
 *
 * 用户可能在 @ 员工后立刻发送：session:setEmployee 的提前物化与
 * agent:send 的发送前物化会并发进入。排队可以避免两边同时删/建链接。
 */
const sessionQueues = new Map<string, Promise<unknown>>();

function enqueueSession<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = sessionQueues.get(sessionId);
  const run = (previous ?? Promise.resolve()).catch(() => undefined).then(task);
  sessionQueues.set(sessionId, run);
  void run
    .finally(() => {
      if (sessionQueues.get(sessionId) === run) {
        sessionQueues.delete(sessionId);
      }
    })
    .catch(() => {
      // 队列清理不参与错误传播
    });
  return run;
}

/**
 * 为一轮聊天准备运行时。
 *
 * @param employee null 表示本轮不指定员工，使用 base home。
 */
export function prepareSessionChatRun(
  session: Session,
  employee: DigitalEmployee | null,
): Promise<SessionChatPreparation> {
  return enqueueSession(session.id, () =>
    prepareSessionChatRunNow(session, employee),
  );
}

async function prepareSessionChatRunNow(
  session: Session,
  employee: DigitalEmployee | null,
): Promise<SessionChatPreparation> {
  await ensureSessionRuntime(session);

  if (!employee) {
    const { home, warnings } = await ensureBaseHome(session);
    return {
      configDir: home,
      extraArgs: [
        "--mcp-config",
        join(home, "mcp.json"),
        // 切换员工时需要重新渲染系统提示词，不能复用首轮快照
        "--system-prompt-snapshot",
        "off",
      ],
      systemPrompt: BASE_CHAT_PROMPT,
      warnings,
    };
  }

  const { home, warnings } = await ensureEmployeeHome(session, employee);
  const knowledge = await resolveEmployeeKnowledge(employee.knowledgeBases);

  return {
    configDir: home,
    extraArgs: [
      "--mcp-config",
      join(home, "mcp.json"),
      "--strict-mcp-config",
      "--system-prompt-snapshot",
      "off",
    ],
    systemPrompt: composeEmployeeChatPrompt(employee, knowledge.promptSection),
    warnings: [...warnings, ...knowledge.warnings],
  };
}

/**
 * 会话创建时提前准备 base 环境。
 * 返回 base home，供 sessions.config_dir 记录。
 */
export function ensureSessionBaseRuntime(session: Session): Promise<string> {
  return enqueueSession(session.id, async () => {
    await ensureSessionRuntime(session);
    const { home } = await ensureBaseHome(session);
    return home;
  });
}

/**
 * 用户 @ / 选中某个员工时提前准备该员工的 home。
 * 发送时还会再检查一次，确保技能 / MCP 是最新的。
 */
export function ensureSessionEmployeeRuntime(
  session: Session,
  employee: DigitalEmployee,
): Promise<{ home: string; warnings: string[] }> {
  return enqueueSession(session.id, async () => {
    await ensureSessionRuntime(session);
    return ensureEmployeeHome(session, employee);
  });
}

/** 删除某个会话的运行时目录；链接只删链接，不会碰全局技能 */
export async function removeSessionRuntime(sessionId: string): Promise<void> {
  await rm(sessionRuntimeDir(sessionId), {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  }).catch(() => {
    // 删除失败不影响会话记录
  });
  await rmdir(RUNTIME_ROOT).catch(() => {});
}
