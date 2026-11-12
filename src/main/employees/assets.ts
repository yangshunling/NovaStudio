/**
 * 数字员工资产解析
 *
 * 员工记录里只有引用键，真正的资产在全局位置：
 * - MCP → `~/.claude.json` 顶层 mcpServers
 * - Skill → `~/.claude/skills/<key>`
 *
 * 聊天（员工常驻目录）与工作流（attempt 临时目录）共用这一份解析，
 * 避免两边对旧版内联 MCP、旧版技能路径的处理各自漂移。
 */

import { existsSync } from "fs";
import { basename, join } from "path";
import { parseKeyValueLines, splitArgs } from "../../shared/mcp";
import type {
  DigitalEmployee,
  EmployeeMcpServer,
} from "../../shared/types";
import { claudeSkillsDir, readClaudeMcpServers } from "../agents/claude/config";

/** `claude-global:<key>` / `library:<key>` → `<key>` */
export function stripAssetOrigin(value: string): string {
  const index = value.indexOf(":");
  return index >= 0 ? value.slice(index + 1) : value;
}

export interface ResolvedSkill {
  /** 引用键（assetId / 历史 source 的目录名） */
  key: string;
  /** 投影到员工 home 时的目录名 */
  targetKey: string;
  name: string;
  /** 源目录绝对路径；可能不存在，由调用方决定是否警告 */
  source: string;
}

/**
 * 员工勾选的技能 → 源目录。
 *
 * 已启用的绑定才参与；同一 key / 同一目标目录只保留第一次出现，
 * 避免重复复制与相互覆盖。
 */
export function resolveEmployeeSkills(
  employee: Pick<DigitalEmployee, "skills">,
): ResolvedSkill[] {
  const result: ResolvedSkill[] = [];
  const seenKeys = new Set<string>();
  const seenTargets = new Set<string>();

  for (const ref of employee.skills.filter((item) => item.enabled)) {
    const key = stripAssetOrigin(ref.assetId || ref.name || "").trim();
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);

    // 新版引用从全局技能目录复制；旧版 source 直接记录了技能目录路径
    const source = ref.assetId
      ? join(claudeSkillsDir(), key)
      : ref.source && existsSync(ref.source)
        ? ref.source
        : join(claudeSkillsDir(), key);

    const targetKey = ref.assetId ? key : basename(source) || key;
    if (seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);

    result.push({
      key,
      targetKey,
      name: ref.name || key,
      source,
    });
  }

  return result;
}

export interface ResolvedMcpServer {
  key: string;
  name: string;
  /** 定义缺失时为 null，由调用方决定是否警告 */
  definition: Record<string, unknown> | null;
}

/** 旧版员工把 MCP 定义内联在员工记录里（assetId 为空） */
function inlineMcpDefinition(
  ref: EmployeeMcpServer,
): Record<string, unknown> | null {
  if (!ref.command?.trim()) return null;
  return {
    command: ref.command.trim(),
    args: splitArgs(ref.args ?? ""),
    env: parseKeyValueLines(ref.env ?? ""),
  };
}

/**
 * 员工勾选的 MCP → 可直接写入 mcp.json 的定义。
 *
 * 新版按 assetId 从全局配置取值；旧版内联定义优先，找不到时再回退全局。
 */
export function resolveEmployeeMcpServers(
  employee: Pick<DigitalEmployee, "mcpServers">,
  globalMcp: Record<string, unknown> = readClaudeMcpServers(),
): ResolvedMcpServer[] {
  const result: ResolvedMcpServer[] = [];
  const seen = new Set<string>();

  for (const ref of employee.mcpServers.filter((item) => item.enabled)) {
    const key = ref.assetId
      ? stripAssetOrigin(ref.assetId || ref.name || "").trim()
      : (ref.name || ref.command || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const definition = ref.assetId
      ? globalMcp[key]
      : (inlineMcpDefinition(ref) ?? globalMcp[key]);

    result.push({
      key,
      name: ref.name || key,
      definition:
        definition && typeof definition === "object"
          ? (definition as Record<string, unknown>)
          : null,
    });
  }

  return result;
}

/** 员工引用的全部技能 / MCP 键（供调试与运行产物展示） */
export function employeeAssetKeys(
  employee: Pick<DigitalEmployee, "skills" | "mcpServers">,
): { skills: string[]; mcpServers: string[] } {
  return {
    skills: resolveEmployeeSkills(employee).map((item) => item.targetKey),
    mcpServers: resolveEmployeeMcpServers(employee).map((item) => item.key),
  };
}
