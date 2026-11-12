/**
 * Claude Code 聊天运行时
 *
 * 一个会话 = 一份对话 + 多个可切换的 home：
 *
 *   <会话运行时根目录>/
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
 *
 * 目录布局与 CLI 参数全部收敛在本文件；宿主只传会话级路径，不感知 Claude 细节。
 */

import { existsSync } from "fs";
import { cp, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { DigitalEmployee, Session } from "../../../shared/types";
import { BASE_CHAT_NAME } from "../chat-identity";
import type { ChatRuntimeInput, ChatRuntimePaths, PreparedChatRun } from "../types";
import { claudeConfigDir, readClaudeMcpServers } from "./config";
import { copySessionFileToProjects } from "./sessions";
import { resolveEmployeeKnowledge } from "../../knowledge/runtime";
import {
  composeEmployeeChatPrompt,
  createDirLink,
  ensureEmployeeRuntimeLayout,
  isLinkTo,
  projectEmployeeAssets,
  removePath,
  syncClaudeBaseFiles,
} from "../../employees/runtime";

/** base 环境需要镜像的全局目录；员工环境不镜像这些，保持隔离 */
const GLOBAL_DIRS = [
  "skills",
  "plugins",
  "agents",
  "commands",
  "output-styles",
] as const;

function assertEmployeeId(employeeId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(employeeId)) {
    throw new Error(`非法员工 id: ${employeeId}`);
  }
}

/** 无员工时使用的 base home */
function sessionBaseHome(paths: ChatRuntimePaths): string {
  return join(paths.root, "claude-home");
}

/** @ 某个员工时使用的员工 home */
function sessionEmployeeHome(
  paths: ChatRuntimePaths,
  employeeId: string,
): string {
  assertEmployeeId(employeeId);
  return join(paths.root, "employees", employeeId, "claude-home");
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
async function ensureSessionRuntime(
  session: Session,
  projectsDir: string,
): Promise<void> {
  await mkdir(projectsDir, { recursive: true });

  if (session.agentSessionId) {
    const copied = await copySessionFileToProjects(
      session.agentSessionId,
      session.cwd,
      session.configDir ?? null,
      projectsDir,
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
  paths: ChatRuntimePaths,
): Promise<{ home: string; warnings: string[] }> {
  const home = sessionBaseHome(paths);
  const warnings: string[] = [];

  await mkdir(home, { recursive: true });
  await ensureDirLink(
    paths.projectsDir,
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
  employee: DigitalEmployee,
  paths: ChatRuntimePaths,
): Promise<{ home: string; warnings: string[] }> {
  const home = sessionEmployeeHome(paths, employee.id);
  const warnings: string[] = [];

  // 顺手清掉旧版留下的 employee/<id> 资产目录（幂等）
  await ensureEmployeeRuntimeLayout(employee.id);

  await mkdir(home, { recursive: true });
  await ensureDirLink(
    paths.projectsDir,
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
const BASE_CHAT_PROMPT = [
  `你是「${BASE_CHAT_NAME}」，使用本机 Claude Code 的全局配置回答。`,
  "本会话可能由多位数字员工先后发言；他们的自我介绍不代表你，不要沿用其他角色的身份或职责。",
  "上下文里每条用户消息都以「@回答者」开头；前缀只用于区分发言者，不是你回复的一部分。",
  `当用户问「你是谁」时，以「${BASE_CHAT_NAME}」自称；只有被明确询问底层模型或运行平台时，才说明由 Claude Code 驱动。`,
].join("");

/** 一次聊天运行：准备会话 home 与 CLI 参数 */
export async function prepareClaudeChatRun(
  input: ChatRuntimeInput,
): Promise<PreparedChatRun> {
  const { session, employee, paths } = input;
  const purpose = input.purpose ?? "send";

  await ensureSessionRuntime(session, paths.projectsDir);

  if (!employee) {
    const { home, warnings } = await ensureBaseHome(paths);
    return {
      configDir: home,
      env: { CLAUDE_CONFIG_DIR: home },
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

  const { home, warnings } = await ensureEmployeeHome(employee, paths);

  // 只是提前物化目录（切换员工时）：跳过知识库扫描，发送前还会再准备一次
  if (purpose === "materialize") {
    return {
      configDir: home,
      env: { CLAUDE_CONFIG_DIR: home },
      warnings,
    };
  }

  const knowledge = await resolveEmployeeKnowledge(employee.knowledgeBases);
  return {
    configDir: home,
    env: { CLAUDE_CONFIG_DIR: home },
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
