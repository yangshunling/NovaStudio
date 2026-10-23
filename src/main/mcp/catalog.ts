/**
 * MCP 服务资产
 *
 * 存储方式与 Skill 一致：一条服务一个 JSON 文件，放在 ~/.novastudio/mcp/。
 * 与 Skill 的区别在运行方式：MCP 不是把目录复制给 Agent，而是每次运行时
 * 把服务定义渲染成目标 Agent 的配置文件。
 *
 * 只读来源目前只有 Claude 用户配置（~/.claude.json 的 mcpServers）。
 * Nova 不改原配置，只做发现与引用。
 */

import { existsSync } from "fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { DATA_DIR } from "../utils/paths";
import { formatKeyValue, parseKeyValueLines, splitArgs } from "../../shared/mcp";
import type {
  McpImportResult,
  McpServerAsset,
  McpServerDraft,
  McpSource,
  McpTransport,
  McpWriteResult,
} from "../../shared/types";

/** Nova MCP 主库：唯一可写目录 */
export const MCP_LIBRARY_DIR = join(DATA_DIR, "mcp");

/** Claude 用户配置（包含全局 mcpServers） */
const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");

/** 单文件 / 配置读取上限，防止异常文件拖垮主进程 */
const MAX_JSON_BYTES = 5_000_000;

const SOURCE_META: Record<McpSource, { readOnly: boolean; reason: string | null }> = {
  library: { readOnly: false, reason: null },
  "claude-global": {
    readOnly: true,
    reason:
      "该服务来自 Claude 配置（用户级 ~/.claude.json 或项目级 .mcp.json），由 Claude Code 管理。Nova 只能引用，不能修改或删除；如需修改，请直接编辑对应配置文件。",
  },
};

// ============================================================================
// 通用解析
// ============================================================================

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") return splitArgs(value);
  return [];
}

function toRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") result[key] = item;
    else if (item != null) result[key] = String(item);
  }
  return result;
}

/**
 * 归一化传输方式。
 *
 * 很多现成配置只写 `url` 不写 `type`（Claude 会按远程 HTTP 处理），
 * 因此有 url 时默认推断为 http；同时兼容常见的类型别名。
 */
function normalizeTransport(value: unknown, url: string): McpTransport {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    raw === "http" ||
    raw === "streamable-http" ||
    raw === "streamablehttp" ||
    raw === "remote"
  ) {
    return "http";
  }
  if (raw === "sse") return "sse";
  if (raw === "stdio" || raw === "local" || raw === "command") return "stdio";
  return url.trim() ? "http" : "stdio";
}

/**
 * 是否包含字面量密钥。
 * 只要值里用到了 ${VAR} 占位符就视为由环境注入（例如 `Bearer ${TOKEN}`），
 * 不标「含密钥」；完全字面量的值才提示用户。
 */
function hasLiteralSecrets(env: Record<string, string>, headers: Record<string, string>): boolean {
  return [...Object.values(env), ...Object.values(headers)].some(
    (value) => value.trim() !== "" && !/\$\{[^}]+\}/.test(value),
  );
}

/**
 * 校验服务定义。
 * 返回空数组表示可正常使用；否则 UI 标「需处理」。
 */
function validate(input: {
  name: string;
  transport: McpTransport;
  command: string;
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
}): string[] {
  const problems: string[] = [];
  if (!input.name) {
    problems.push("服务名不能为空");
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.name)) {
    problems.push("服务名只能包含字母、数字、点、下划线和连字符");
  }

  if (input.transport === "stdio") {
    if (!input.command.trim()) problems.push("stdio 服务必须填写启动命令");
  } else if (!/^https?:\/\//i.test(input.url.trim())) {
    problems.push(`${input.transport} 服务必须填写 http(s) URL`);
  }

  for (const key of Object.keys(input.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      problems.push(`环境变量名不合法：${key}`);
    }
  }
  for (const key of Object.keys(input.headers)) {
    // HTTP token 允许下划线、点等字符，实际配置里 devops_access_key 这类很常见
    if (!/^[A-Za-z0-9._-]+$/.test(key)) {
      problems.push(`请求头名称不合法：${key}`);
    }
  }

  return problems;
}

function toSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug || `mcp-${Date.now().toString(36)}`;
}

function uniqueSlug(base: string, existing: Set<string>): string {
  let slug = base;
  let index = 2;
  while (existing.has(slug)) {
    slug = `${base}-${index}`;
    index += 1;
  }
  return slug;
}

// ============================================================================
// 扫描
// ============================================================================

interface ParsedServer {
  name: string;
  description: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
}

/**
 * 兼容多种常见写法：
 * - Nova 格式：{ name, description, transport, command, args, env, url, headers }
 * - Claude 格式：{ command, args, env } 或 { type: "http", url, headers }
 */
function parseServerObject(
  raw: unknown,
  fallbackName: string,
): ParsedServer {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const url = toText(value.url);
  return {
    name: toText(value.name) || fallbackName,
    description: toText(value.description),
    transport: normalizeTransport(value.transport ?? value.type, url),
    command: toText(value.command),
    args: toStringArray(value.args),
    env: toRecord(value.env ?? value.environment),
    url,
    headers: toRecord(value.headers),
  };
}

function toAsset(
  parsed: ParsedServer,
  input: {
    id: string;
    slug: string;
    path: string;
    source: McpSource;
    updatedAt: number;
  },
): McpServerAsset {
  const meta = SOURCE_META[input.source];
  const problems = validate(parsed);
  return {
    id: input.id,
    slug: input.slug,
    name: parsed.name,
    description: parsed.description,
    transport: parsed.transport,
    command: parsed.command,
    args: parsed.args,
    env: parsed.env,
    url: parsed.url,
    headers: parsed.headers,
    path: input.path,
    source: input.source,
    readOnly: meta.readOnly,
    readOnlyReason: meta.reason,
    hasSecrets: hasLiteralSecrets(parsed.env, parsed.headers),
    valid: problems.length === 0,
    problems,
    updatedAt: input.updatedAt,
  };
}

async function scanLibrary(): Promise<McpServerAsset[]> {
  await mkdir(MCP_LIBRARY_DIR, { recursive: true });

  let names: string[];
  try {
    names = await readdir(MCP_LIBRARY_DIR);
  } catch {
    return [];
  }

  const result: McpServerAsset[] = [];
  for (const fileName of names) {
    if (!fileName.toLowerCase().endsWith(".json") || fileName.startsWith(".")) {
      continue;
    }

    const slug = fileName.replace(/\.json$/i, "");
    const filePath = join(MCP_LIBRARY_DIR, fileName);
    let info;
    try {
      info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_JSON_BYTES) continue;
      const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      // 兼容误用 { mcpServers: { name: cfg } } 导出的文件
      const container =
        raw && typeof raw === "object" && "mcpServers" in raw
          ? (raw as { mcpServers?: unknown }).mcpServers
          : null;
      if (container && typeof container === "object" && !Array.isArray(container)) {
        const entries = Object.entries(container as Record<string, unknown>);
        if (entries.length === 1) {
          result.push(
            toAsset(parseServerObject(entries[0][1], entries[0][0]), {
              id: `library:${slug}`,
              slug,
              path: filePath,
              source: "library",
              updatedAt: info.mtimeMs,
            }),
          );
          continue;
        }
      }
      result.push(
        toAsset(parseServerObject(raw, slug), {
          id: `library:${slug}`,
          slug,
          path: filePath,
          source: "library",
          updatedAt: info.mtimeMs,
        }),
      );
    } catch (err) {
      // 损坏的文件仍然展示出来，允许用户删除或修复
      const problems = [
        `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
      ];
      result.push({
        id: `library:${slug}`,
        slug,
        name: slug,
        description: "",
        transport: "stdio",
        command: "",
        args: [],
        env: {},
        url: "",
        headers: {},
        path: filePath,
        source: "library",
        readOnly: false,
        readOnlyReason: null,
        hasSecrets: false,
        valid: false,
        problems,
        updatedAt: Date.now(),
      });
    }
  }

  return result;
}

/** 从一份 Claude 配置对象的 mcpServers 里生成资产 */
function serversFromConfig(
  config: unknown,
  input: {
    idPrefix: string;
    path: string;
    source: McpSource;
    updatedAt: number;
  },
): McpServerAsset[] {
  const servers =
    config && typeof config === "object"
      ? (config as { mcpServers?: unknown }).mcpServers
      : null;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return [];
  }

  return Object.entries(servers as Record<string, unknown>).map(([name, raw]) =>
    toAsset(parseServerObject(raw, name), {
      id: `${input.idPrefix}:${name}`,
      slug: name,
      path: input.path,
      source: input.source,
      updatedAt: input.updatedAt,
    }),
  );
}

/**
 * 扫描 Claude 的 MCP 配置，共三类：
 * - 用户级：~/.claude.json 顶层 mcpServers
 * - 项目 local scope：~/.claude.json 的 projects[<dir>].mcpServers
 * - 项目级文件：<dir>/.mcp.json（Claude 在项目里用 /mcp 添加的服务通常落在这里）
 *
 * projects 的目录列表同样来自 ~/.claude.json，避免全盘扫描。
 */
async function scanClaudeConfigs(): Promise<McpServerAsset[]> {
  if (!existsSync(CLAUDE_CONFIG_PATH)) return [];

  let info;
  let data: unknown;
  try {
    info = await stat(CLAUDE_CONFIG_PATH);
    if (info.size > MAX_JSON_BYTES) return [];
    data = JSON.parse(await readFile(CLAUDE_CONFIG_PATH, "utf8"));
  } catch {
    return [];
  }

  const result = serversFromConfig(data, {
    idPrefix: "claude-global",
    path: CLAUDE_CONFIG_PATH,
    source: "claude-global",
    updatedAt: info.mtimeMs,
  });

  const projects =
    data && typeof data === "object"
      ? (data as { projects?: unknown }).projects
      : null;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    return result;
  }

  for (const [projectDir, projectConfig] of Object.entries(
    projects as Record<string, unknown>,
  )) {
    // local scope：直接存在 ~/.claude.json 的项目条目里
    result.push(
      ...serversFromConfig(projectConfig, {
        idPrefix: `claude-global:local:${projectDir}`,
        path: CLAUDE_CONFIG_PATH,
        source: "claude-global",
        updatedAt: info.mtimeMs,
      }),
    );

    // project scope：<项目>/.mcp.json
    const filePath = join(projectDir, ".mcp.json");
    if (!existsSync(filePath)) continue;

    try {
      const fileInfo = await stat(filePath);
      if (fileInfo.size > MAX_JSON_BYTES) continue;
      const fileData = JSON.parse(await readFile(filePath, "utf8"));
      result.push(
        ...serversFromConfig(fileData, {
          idPrefix: `claude-global:file:${projectDir}`,
          path: filePath,
          source: "claude-global",
          updatedAt: fileInfo.mtimeMs,
        }),
      );
    } catch {
      // 单个项目配置损坏不影响其它来源
    }
  }

  return result;
}

/** 聚合扫描：主库在前，组内按名称排序 */
export async function listMcpServers(): Promise<McpServerAsset[]> {
  const [library, claudeConfigs] = await Promise.all([
    scanLibrary(),
    scanClaudeConfigs(),
  ]);
  const byName = (a: McpServerAsset, b: McpServerAsset) =>
    a.slug.localeCompare(b.slug);
  return [...library.sort(byName), ...claudeConfigs.sort(byName)];
}

export async function getMcpServer(id: string): Promise<McpServerAsset | null> {
  return (await listMcpServers()).find((server) => server.id === id) ?? null;
}

// ============================================================================
// 新建 / 更新 / 删除
// ============================================================================

function draftToParsed(draft: McpServerDraft): ParsedServer {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    transport: normalizeTransport(draft.transport, draft.url),
    command: draft.command.trim(),
    args: draft.args
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    env: parseKeyValueLines(draft.env),
    url: draft.url.trim(),
    headers: parseKeyValueLines(draft.headers),
  };
}

/**
 * 用已知的目录快照完成一次保存。
 *
 * 导入多个服务时复用同一份 `all`，避免每条都全量扫描；
 * 写入后直接用 payload 构造资产，不再回读整个目录。
 */
async function saveWithCatalog(
  id: string | null,
  draft: McpServerDraft,
  all: McpServerAsset[],
): Promise<McpWriteResult> {
  const parsed = draftToParsed(draft);
  const problems = validate(parsed);
  if (problems.length > 0) {
    return { ok: false, error: problems.join("；") };
  }

  const duplicate = all.find(
    (server) =>
      server.source === "library" &&
      server.id !== id &&
      server.name.toLowerCase() === parsed.name.toLowerCase(),
  );
  if (duplicate) {
    return { ok: false, error: `已存在同名 MCP 服务：${parsed.name}` };
  }

  let slug: string;
  if (id) {
    const existing = all.find((server) => server.id === id);
    if (!existing) return { ok: false, error: "MCP 服务不存在，可能已被删除" };
    if (existing.readOnly) {
      return { ok: false, error: existing.readOnlyReason ?? "该服务为只读来源" };
    }
    slug = existing.slug;
  } else {
    const existingSlugs = new Set(
      all.filter((server) => server.source === "library").map((server) => server.slug),
    );
    slug = uniqueSlug(toSlug(parsed.name), existingSlugs);
  }

  const filePath = join(MCP_LIBRARY_DIR, `${slug}.json`);
  const payload = {
    name: parsed.name,
    description: parsed.description,
    transport: parsed.transport,
    command: parsed.command,
    args: parsed.args,
    env: parsed.env,
    url: parsed.url,
    headers: parsed.headers,
  };

  try {
    await mkdir(MCP_LIBRARY_DIR, { recursive: true });
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ok: true,
    asset: toAsset(parsed, {
      id: `library:${slug}`,
      slug,
      path: filePath,
      source: "library",
      updatedAt: Date.now(),
    }),
  };
}

export async function saveMcpServer(
  id: string | null,
  draft: McpServerDraft,
): Promise<McpWriteResult> {
  return saveWithCatalog(id, draft, await listMcpServers());
}

export async function deleteMcpServer(id: string): Promise<boolean> {
  const asset = await getMcpServer(id);
  if (!asset || asset.readOnly || asset.source !== "library") return false;
  await rm(asset.path, { force: true });
  return true;
}

// ============================================================================
// 导入
// ============================================================================

/** 把常见 JSON 形状拆成「名字 → 配置」列表 */
function collectImportEntries(raw: unknown): Array<[string, unknown]> {
  if (Array.isArray(raw)) {
    return raw.map((item, index) => {
      const value =
        item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return [toText(value.name) || `mcp-${index + 1}`, item];
    });
  }

  if (!raw || typeof raw !== "object") return [];

  const value = raw as Record<string, unknown>;
  if (value.mcpServers && typeof value.mcpServers === "object" && !Array.isArray(value.mcpServers)) {
    return Object.entries(value.mcpServers as Record<string, unknown>);
  }

  return [[toText(value.name) || "mcp-server", raw]];
}

export async function importMcpServers(json: string): Promise<McpImportResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      imported: [],
      error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const entries = collectImportEntries(raw);
  if (entries.length === 0) {
    return { ok: false, imported: [], error: "没有找到可导入的 MCP 服务" };
  }

  const imported: McpServerAsset[] = [];
  const errors: string[] = [];

  // 一次扫描，后续逐条在内存快照上做重名 / slug 去重，避免 O(N²) 全量扫描
  const all = await listMcpServers();
  for (const [name, config] of entries) {
    const parsed = parseServerObject(config, name);
    const result = await saveWithCatalog(null, {
      name: parsed.name,
      description: parsed.description,
      transport: parsed.transport,
      command: parsed.command,
      args: parsed.args.join("\n"),
      env: formatKeyValue(parsed.env),
      url: parsed.url,
      headers: formatKeyValue(parsed.headers),
    }, all);
    if (result.ok) {
      imported.push(result.asset);
      all.push(result.asset);
    } else {
      errors.push(`${parsed.name}：${result.error}`);
    }
  }

  if (imported.length === 0) {
    return {
      ok: false,
      imported: [],
      error: errors.join("；") || "导入失败",
    };
  }

  return {
    ok: true,
    imported,
    ...(errors.length > 0 ? { error: `部分失败：${errors.join("；")}` } : {}),
  };
}

export async function importMcpFromPath(filePath: string): Promise<McpImportResult> {
  let content: string;
  try {
    const info = await stat(filePath);
    if (info.size > MAX_JSON_BYTES) {
      return { ok: false, imported: [], error: "文件超过 5MB，已拒绝导入" };
    }
    content = await readFile(filePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      imported: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return importMcpServers(content);
}

