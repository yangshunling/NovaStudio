/**
 * Claude MCP 运行时适配
 *
 * 把员工绑定的 MCP 服务渲染成 Claude 的 mcp.json 内容。
 * 这是 Claude 专属的运行时逻辑，不放在 MCP 资产目录里；catalog 只负责
 * 扫描、导入与文件 CRUD。
 */

import { listMcpServers } from "../../mcp/catalog";
import { parseKeyValueLines, splitArgs } from "../../../shared/mcp";
import type { EmployeeMcpServer, McpTransport } from "../../../shared/types";

/** 解析 ${VAR} / ${VAR:-default} 占位符 */
function resolveTemplate(
  value: string,
  label: string,
  warnings: string[],
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, key: string, fallback: string | undefined) => {
      const resolved = process.env[key];
      if (resolved !== undefined) return resolved;
      if (fallback !== undefined) return fallback;
      warnings.push(`${label} 引用的环境变量 ${key} 未设置，已按空值处理`);
      return "";
    },
  );
}

function resolveRecord(
  record: Record<string, string>,
  label: string,
  warnings: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = resolveTemplate(value, `${label}.${key}`, warnings);
  }
  return result;
}

export interface ClaudeMcpConfig {
  json: string;
  /** 实际注入的服务名 */
  servers: string[];
  warnings: string[];
}

/**
 * 把员工绑定的 MCP 服务渲染成 Claude 的 mcp.json 内容。
 *
 * - assetId 为空时按旧版内联配置渲染（command/args/env）
 * - 同名服务会冲突（工具命名空间），后者跳过并告警
 * - 缺失的资产 / 环境变量都记入 warnings
 */
export async function renderClaudeMcpConfig(
  bindings: EmployeeMcpServer[],
): Promise<ClaudeMcpConfig> {
  const warnings: string[] = [];
  const servers: Record<string, unknown> = {};
  const injected: string[] = [];

  const enabled = bindings.filter((binding) => binding.enabled);
  const catalog = enabled.some((binding) => binding.assetId)
    ? await listMcpServers()
    : [];
  const byId = new Map(catalog.map((asset) => [asset.id, asset]));

  for (const binding of enabled) {
    let name = binding.name || "mcp";
    let transport: McpTransport = "stdio";
    let command = "";
    let args: string[] = [];
    let env: Record<string, string> = {};
    let url = "";
    let headers: Record<string, string> = {};

    if (binding.assetId) {
      const asset = byId.get(binding.assetId);
      if (!asset) {
        warnings.push(`MCP 服务「${name}」不存在（可能已被删除），已跳过`);
        continue;
      }
      name = asset.name;
      transport = asset.transport;
      command = asset.command;
      args = asset.args;
      env = asset.env;
      url = asset.url;
      headers = asset.headers;
      if (!asset.valid) {
        warnings.push(
          `MCP 服务「${name}」未通过校验（${asset.problems.join("；")}），仍尝试注入`,
        );
      }
    } else if (binding.command?.trim()) {
      // 旧版内联配置
      command = binding.command.trim();
      args = splitArgs(binding.args ?? "");
      env = parseKeyValueLines(binding.env ?? "");
    } else {
      warnings.push(`MCP 服务「${name}」没有可用的配置，已跳过`);
      continue;
    }

    if (servers[name]) {
      warnings.push(`MCP 服务名「${name}」重复，后一个已跳过（工具命名空间会冲突）`);
      continue;
    }

    if (transport === "stdio") {
      if (!command) {
        warnings.push(`MCP 服务「${name}」缺少启动命令，已跳过`);
        continue;
      }
      servers[name] = {
        command: resolveTemplate(command, `MCP「${name}」命令`, warnings),
        args: args.map((arg) =>
          resolveTemplate(arg, `MCP「${name}」参数`, warnings),
        ),
        env: resolveRecord(env, `MCP「${name}」`, warnings),
      };
    } else {
      if (!url) {
        warnings.push(`MCP 服务「${name}」缺少 URL，已跳过`);
        continue;
      }
      servers[name] = {
        type: transport,
        url: resolveTemplate(url, `MCP「${name}」URL`, warnings),
        headers: resolveRecord(headers, `MCP「${name}」`, warnings),
      };
    }

    injected.push(name);
  }

  return {
    json: JSON.stringify({ mcpServers: servers }, null, 2),
    servers: injected,
    warnings,
  };
}
