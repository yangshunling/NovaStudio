/**
 * 数字员工操作（SQLite repository）
 *
 * 只包含该领域的 SQL 与行映射；连接与语句缓存见 ../connection。
 */

import { randomUUID } from "crypto";
import { getDb, prepare } from "../connection";
import type { DigitalEmployee, DigitalEmployeeDraft, EmployeeKnowledge, EmployeeMcpServer, EmployeeSkill } from "../../../shared/types";
import { parseJsonArray } from "../../../shared/json";

// ============================================================================
// 数字员工操作
// ============================================================================

/**
 * 员工技能归一化。
 *
 * 旧版存的是 `{ id, name, source, enabled }` 路径条目；新版只存技能资产引用
 * `{ assetId, name, enabled }`。旧条目保留 source，运行时仍可按原语义解析，
 * 在 UI 中标记为「旧版路径」提示重新绑定。
 */
function normalizeEmployeeSkills(raw: string): EmployeeSkill[] {
  return parseJsonArray<Record<string, unknown>>(raw).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const name = typeof item.name === "string" ? item.name : "";
    const source = typeof item.source === "string" ? item.source : undefined;
    const assetId = typeof item.assetId === "string" ? item.assetId : "";
    if (!assetId && !source && !name) return [];
    return [
      {
        assetId,
        name: name || source || "未命名技能",
        ...(source ? { source } : {}),
        enabled: item.enabled !== false,
      },
    ];
  });
}

/**
 * 员工 MCP 归一化。
 *
 * 新版只存资产引用 `{ assetId, name, enabled }`；旧版是内联配置
 * `{ id, name, command, args, env, enabled }`。旧条目保留内联字段，
 * 运行时仍可注入，UI 中标记为「旧版内联」并提示导入 MCP 库。
 */
function normalizeEmployeeMcpServers(raw: string): EmployeeMcpServer[] {
  return parseJsonArray<Record<string, unknown>>(raw).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const assetId = typeof item.assetId === "string" ? item.assetId : "";
    const name = typeof item.name === "string" ? item.name : "";
    const enabled = item.enabled !== false;

    if (assetId) return [{ assetId, name, enabled }];

    const command = typeof item.command === "string" ? item.command : "";
    const args = typeof item.args === "string" ? item.args : "";
    const env = typeof item.env === "string" ? item.env : "";
    if (!command && !args && !env) return [];

    return [
      {
        assetId: "",
        name: name || command || "未命名 MCP",
        enabled,
        command,
        args,
        env,
      },
    ];
  });
}

/** 员工知识库归一化：只接受资产引用，损坏项直接丢弃 */
function normalizeEmployeeKnowledge(raw: string): EmployeeKnowledge[] {
  return parseJsonArray<Record<string, unknown>>(raw).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const assetId = typeof item.assetId === "string" ? item.assetId : "";
    if (!assetId) return [];
    return [
      {
        assetId,
        name: typeof item.name === "string" ? item.name : "",
        enabled: item.enabled !== false,
      },
    ];
  });
}

function rowToDigitalEmployee(row: any): DigitalEmployee {
  return {
    id: row.id,
    name: row.name,
    role: row.role ?? "",
    description: row.description ?? "",
    avatar: row.avatar ?? null,
    systemPrompt: row.system_prompt ?? "",
    mcpServers: normalizeEmployeeMcpServers(row.mcp_servers_json),
    skills: normalizeEmployeeSkills(row.skills_json),
    knowledgeBases: normalizeEmployeeKnowledge(row.knowledge_json ?? "[]"),
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 草稿字段 → SQL 参数（顺序与建表列一致，新建 / 更新共用） */
function employeeParams(draft: DigitalEmployeeDraft): unknown[] {
  return [
    draft.name,
    draft.role,
    draft.description,
    draft.avatar,
    draft.systemPrompt,
    JSON.stringify(draft.mcpServers),
    JSON.stringify(draft.skills),
    JSON.stringify(draft.knowledgeBases ?? []),
    draft.enabled ? 1 : 0,
  ];
}

export function listDigitalEmployees(): DigitalEmployee[] {
  const rows = getDb()
    .prepare("SELECT * FROM digital_employees ORDER BY updated_at DESC")
    .all() as any[];
  return rows.map(rowToDigitalEmployee);
}

export function getDigitalEmployee(id: string): DigitalEmployee | null {
  const row = prepare("SELECT * FROM digital_employees WHERE id = ?").get(id) as any;
  return row ? rowToDigitalEmployee(row) : null;
}

export function createDigitalEmployee(draft: DigitalEmployeeDraft): DigitalEmployee {
  const id = randomUUID();
  const now = Date.now();
  prepare(
    `INSERT INTO digital_employees (
      id, name, role, description, avatar,
      system_prompt, mcp_servers_json, skills_json, knowledge_json,
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ...employeeParams(draft), now, now);
  return getDigitalEmployee(id)!;
}

export function updateDigitalEmployee(
  id: string,
  draft: DigitalEmployeeDraft,
): DigitalEmployee | null {
  const info = getDb()
    .prepare(
      `UPDATE digital_employees SET
        name = ?, role = ?, description = ?, avatar = ?,
        system_prompt = ?, mcp_servers_json = ?, skills_json = ?, knowledge_json = ?,
        enabled = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(...employeeParams(draft), Date.now(), id);
  return info.changes > 0 ? getDigitalEmployee(id) : null;
}

export function deleteDigitalEmployee(id: string): void {
  prepare("DELETE FROM digital_employees WHERE id = ?").run(id);
}

/** 只更新员工的 MCP / Skill 引用，避免改动其它字段 */
export function updateEmployeeBindings(
  id: string,
  mcpServersJson: string,
  skillsJson: string,
): void {
  getDb()
    .prepare(
      "UPDATE digital_employees SET mcp_servers_json = ?, skills_json = ?, updated_at = ? WHERE id = ?",
    )
    .run(mcpServersJson, skillsJson, Date.now(), id);
}

