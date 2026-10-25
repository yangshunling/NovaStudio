/**
 * Claude Code 连接配置（Nova 自管）
 *
 * 设计目标：运行时**不读取**本机 `~/.claude` 的任何配置，所有接入信息
 * （Base URL / API Key / 默认模型）都由 Nova 自己维护。
 *
 * 配置以文件为唯一来源：
 *   ~/.novastudio/agent-connections/claude/settings.json  Claude 原生配置（含明文 Key）
 *   ~/.novastudio/agent-connections/claude/models.json    Nova 的模型清单缓存
 *
 * - 保存时直接写文件；节点执行时复制 settings.json 到隔离目录
 * - 数据库里的 agent_connections 只作为旧版本升级的迁移来源，迁移后删除
 * - 「从本机导入」是一次性动作：读本机 settings.json 写入 Nova
 * - OAuth 凭证是唯一例外：没有 API Key 时，运行期复制一份 `.credentials.json`
 *   到节点的隔离目录（只复制，不共享目录）
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type {
  AgentConnection,
  AgentConnectionDraft,
  AgentConnectionImportResult,
  AgentConnectionProbeInput,
  AgentConnectionProbeResult,
  AgentModelOption,
} from "../../../shared/contracts/agent";
import * as db from "../../db/sqlite";
import {
  decryptSecret,
  maskSecret,
  type SecretStorage,
} from "../connection-secret";
import { DATA_DIR } from "../../utils/paths";

export const CLAUDE_AGENT_ID = "claude";
export const DEFAULT_BASE_URL = "https://api.anthropic.com";

const FETCH_TIMEOUT_MS = 8000;
const OFFICIAL_HOST = "api.anthropic.com";
const ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

/**
 * 节点子进程需要剔除的接入变量。
 *
 * 节点以复制过去的 settings.json 为准；如果宿主进程（比如从终端启动 Nova）
 * 里还留着 ANTHROPIC_*，Claude 会优先使用环境变量，隔离就失效了。
 */
export const CLAUDE_CONNECTION_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  ...ALIASES.flatMap((alias) => {
    const upper = alias.toUpperCase();
    return [
      `ANTHROPIC_DEFAULT_${upper}_MODEL`,
      `ANTHROPIC_DEFAULT_${upper}_MODEL_NAME`,
    ];
  }),
];

/** 主进程内部使用的完整连接（含解密后的密钥，绝不外传渲染层） */
export interface ClaudeConnection {
  agentId: string;
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
  /** 有密文但解密失败（跨设备 / 备份还原） */
  keyUnreadable: boolean;
  keyStorage: SecretStorage;
  defaultModel: string;
  models: AgentModelOption[];
  modelsUpdatedAt: number | null;
  updatedAt: number | null;
}

export type ClaudeAuthMode = "api-key" | "auth-token" | "oauth-copy" | "none";

// ============================================================================
// 读取 / 保存
// ============================================================================

function parseModels(raw: string): AgentModelOption[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is {
          value: string;
          label?: unknown;
          hint?: unknown;
          alias?: unknown;
        } =>
          !!item && typeof item === "object" && typeof (item as any).value === "string",
      )
      .map((item) => ({
        value: item.value,
        label: typeof item.label === "string" && item.label ? item.label : item.value,
        hint: typeof item.hint === "string" && item.hint ? item.hint : undefined,
        alias:
          typeof item.alias === "string" && item.alias ? item.alias : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * 用旧列表里的别名信息补全新列表。
 *
 * 远端 /v1/models 只返回模型 id，不带 Nova 的别名映射；如果直接用新列表
 * 覆盖，老员工里保存的 `sonnet` 之类别名就会失去映射。这里按 value 对齐，
 * 只保留新列表里的模型，同时把旧列表的 alias 带过来。
 */
function preserveModelAliases(
  incoming: AgentModelOption[],
  previous: AgentModelOption[],
): AgentModelOption[] {
  const byValue = new Map(previous.map((model) => [model.value, model]));
  return incoming.map((model) => {
    const old = byValue.get(model.value);
    if (!old?.alias) return model;
    return { ...model, alias: old.alias, hint: model.hint ?? old.hint };
  });
}

/** 空的默认连接（用于从未配置过的情况） */
function emptyConnection(): ClaudeConnection {
  return {
    agentId: CLAUDE_AGENT_ID,
    baseUrl: "",
    apiKey: "",
    hasApiKey: false,
    keyUnreadable: false,
    keyStorage: "none",
    defaultModel: "",
    models: [],
    modelsUpdatedAt: null,
    updatedAt: null,
  };
}

// ============================================================================
// 文件读取（唯一来源）
// ============================================================================

interface ModelsFile {
  updatedAt: number | null;
  /** Nova 的默认模型；不写入 settings.json，避免覆盖每个节点的 --model */
  defaultModel: string;
  models: AgentModelOption[];
}

/** 从 models.json 读取模型缓存；缺失或损坏时返回空列表 */
function readModelsFile(): ModelsFile {
  const path = claudeModelsPath();
  if (!existsSync(path)) {
    return { updatedAt: null, defaultModel: "", models: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      updatedAt?: unknown;
      defaultModel?: unknown;
      models?: unknown;
    };
    return {
      updatedAt:
        typeof parsed.updatedAt === "number" ? parsed.updatedAt : null,
      defaultModel:
        typeof parsed.defaultModel === "string" ? parsed.defaultModel : "",
      models: Array.isArray(parsed.models)
        ? parseModels(JSON.stringify(parsed.models))
        : [],
    };
  } catch {
    return { updatedAt: null, defaultModel: "", models: [] };
  }
}

/** 写入模型缓存 + Nova 默认模型 */
function writeModelsFile(
  models: AgentModelOption[],
  updatedAt: number | null,
  defaultModel: string,
): void {
  const path = claudeModelsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ updatedAt, defaultModel, models }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

/** 从标准文件读取连接；settings.json 不存在或无法解析时返回 null */
function readConnectionFromFiles(): ClaudeConnection | null {
  const settingsPath = claudeSettingsPath();
  if (!existsSync(settingsPath)) return null;

  let env: Record<string, string> = {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      env?: Record<string, unknown>;
    };
    if (parsed.env && typeof parsed.env === "object") {
      for (const [key, value] of Object.entries(parsed.env)) {
        if (typeof value === "string") env[key] = value;
      }
    }
  } catch {
    return null;
  }

  const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
  const baseUrl = env.ANTHROPIC_BASE_URL || "";
  const modelsFile = readModelsFile();
  // 默认模型优先取 Nova 的 models.json；兼容用户手动写在 settings.json 里的情况
  const defaultModel = modelsFile.defaultModel || env.ANTHROPIC_MODEL || "";

  // settings.json 里的别名映射优先于 models.json 里的旧值
  const aliasByValue = new Map<string, string>();
  for (const alias of ALIASES) {
    const value = env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`];
    if (value) aliasByValue.set(value, alias);
  }

  let models = modelsFile.models.map((model) => {
    const alias = aliasByValue.get(model.value);
    return alias ? { ...model, alias } : model;
  });

  // models.json 丢失时，至少把 settings.json 里的别名映射展示出来
  if (models.length === 0 && aliasByValue.size > 0) {
    models = [...aliasByValue.entries()].map(([value, alias]) => ({
      value,
      label: value,
      hint: `${alias} 别名映射`,
      alias,
    }));
  }

  let updatedAt: number | null = null;
  try {
    updatedAt = statSync(settingsPath).mtimeMs;
  } catch {
    updatedAt = null;
  }

  return {
    agentId: CLAUDE_AGENT_ID,
    baseUrl,
    apiKey,
    hasApiKey: Boolean(apiKey),
    keyUnreadable: false,
    keyStorage: apiKey ? "plaintext" : "none",
    defaultModel,
    models,
    modelsUpdatedAt: modelsFile.updatedAt ?? updatedAt,
    updatedAt,
  };
}

/** 旧版本数据库记录：只用于升级迁移 */
function readConnectionFromDb(): ClaudeConnection | null {
  const row = db.getAgentConnectionRow(CLAUDE_AGENT_ID);
  if (!row) return null;

  const apiKey = decryptSecret(row.apiKey);
  return {
    agentId: CLAUDE_AGENT_ID,
    baseUrl: row.baseUrl,
    apiKey,
    hasApiKey: Boolean(apiKey),
    keyUnreadable: Boolean(row.apiKey) && !apiKey,
    keyStorage: apiKey ? (row.apiKeyStorage as SecretStorage) : "none",
    defaultModel: row.defaultModel,
    models: parseModels(row.modelsJson),
    modelsUpdatedAt: row.modelsUpdatedAt,
    updatedAt: row.updatedAt,
  };
}

/** 写标准文件 + 模型缓存 */
function writeConnectionFiles(conn: ClaudeConnection): void {
  materializeClaudeSettingsFile(conn);
  writeModelsFile(conn.models, conn.modelsUpdatedAt, conn.defaultModel);
}

/**
 * 旧数据库 → 标准文件的一次性迁移。
 * 迁移成功后删除旧行，确保以后只认文件；返回的文件内容才是当前有效配置。
 */
function migrateFromDb(): ClaudeConnection | null {
  const fromDb = readConnectionFromDb();
  if (!fromDb) return null;

  writeConnectionFiles(fromDb);
  db.deleteAgentConnectionRow(CLAUDE_AGENT_ID);
  return readConnectionFromFiles() ?? fromDb;
}

/** 连接配置的唯一读取入口：文件优先，缺失时迁移旧数据库 */
export function getClaudeConnection(): ClaudeConnection {
  return readConnectionFromFiles() ?? migrateFromDb() ?? emptyConnection();
}

// ============================================================================
// 标准配置文件（保存时生成，执行时复制）
// ============================================================================

/** 标准配置目录：~/.novastudio/agent-connections/claude/ */
export function claudeSettingsDirPath(): string {
  return join(DATA_DIR, "agent-connections", "claude");
}

/** 标准配置文件路径：~/.novastudio/agent-connections/claude/settings.json */
export function claudeSettingsPath(): string {
  return join(claudeSettingsDirPath(), "settings.json");
}

/** 模型清单缓存路径：~/.novastudio/agent-connections/claude/models.json */
export function claudeModelsPath(): string {
  return join(claudeSettingsDirPath(), "models.json");
}

/**
 * 生成 Claude 原生 settings.json 的内容。
 *
 * 只写接入层（Base URL / Key / 别名映射），**不写 ANTHROPIC_MODEL**：
 * 实测该变量会覆盖最终传给 CLI 的 `--model`，导致每个员工/节点绑定的
 * 模型失效。默认模型由 Nova 存在 models.json，再由宿主编进 `--model`。
 *
 * 这里刻意写入明文 Key：用户明确选择「不把密钥安全作为约束」，
 * 以换取保存即生成文件、执行时直接复制的简单模型。
 */
export function buildClaudeSettings(conn: ClaudeConnection): {
  env: Record<string, string>;
} {
  return { env: resolveClaudeEnv(conn) };
}

/** 把当前连接落成一份标准配置文件；返回文件路径 */
export function materializeClaudeSettingsFile(conn: ClaudeConnection): string {
  const path = claudeSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(buildClaudeSettings(conn), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

/**
 * 启动时确保标准文件存在：
 * - 文件已存在：只在 models.json 缺失时用旧数据库补一次模型缓存
 * - 文件不存在：从旧数据库迁移；没有旧记录则返回 null
 */
export function ensureClaudeSettingsFile(): string | null {
  const settingsPath = claudeSettingsPath();
  if (existsSync(settingsPath)) {
    if (!existsSync(claudeModelsPath())) {
      const fromDb = readConnectionFromDb();
      if (fromDb) {
        writeModelsFile(
          fromDb.models,
          fromDb.modelsUpdatedAt,
          fromDb.defaultModel,
        );
      }
    }
    return settingsPath;
  }

  migrateFromDb();
  return existsSync(settingsPath) ? settingsPath : null;
}

/** 转成渲染层可见的脱敏视图 */
export function toPublicConnection(conn: ClaudeConnection): AgentConnection {
  return {
    agentId: conn.agentId,
    baseUrl: conn.baseUrl,
    defaultModel: conn.defaultModel,
    models: conn.models,
    hasApiKey: conn.hasApiKey,
    apiKeyHint: maskSecret(conn.apiKey),
    // 新模型下密钥只存在于标准配置文件中（明文）
    keyStorage: conn.hasApiKey ? "plaintext" : "none",
    keyUnreadable: conn.keyUnreadable,
    oauthAvailable: hasOAuthCredentials(),
    settingsPath: claudeSettingsPath(),
    modelsUpdatedAt: conn.modelsUpdatedAt,
    updatedAt: conn.updatedAt,
  };
}

/** 渲染层读取入口：目前只有 Claude 支持 Nova 连接配置 */
export function getAgentConnectionView(agentId: string): AgentConnection {
  if (agentId !== CLAUDE_AGENT_ID) {
    return {
      agentId,
      baseUrl: "",
      defaultModel: "",
      models: [],
      hasApiKey: false,
      apiKeyHint: "",
      keyStorage: "none",
      keyUnreadable: false,
      oauthAvailable: false,
      settingsPath: "",
      modelsUpdatedAt: null,
      updatedAt: null,
    };
  }
  return toPublicConnection(getClaudeConnection());
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Base URL 不是合法地址，请填写完整的 http(s) 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL 只支持 http / https");
  }
  // 去掉结尾斜杠，避免拼出 //v1/models
  return trimmed.replace(/\/+$/, "");
}

export function saveClaudeConnection(draft: AgentConnectionDraft): AgentConnection {
  if (draft.agentId !== CLAUDE_AGENT_ID) {
    throw new Error(`当前仅支持配置 Claude Code 的连接（收到：${draft.agentId}）`);
  }

  const existing = getClaudeConnection();
  const baseUrl = normalizeBaseUrl(draft.baseUrl);
  const now = Date.now();

  // 密钥更新语义：undefined 保持、"" 清除、其他写入
  const apiKey =
    draft.apiKey === undefined ? existing.apiKey : draft.apiKey.trim();

  const models = preserveModelAliases(
    draft.models ?? existing.models,
    existing.models,
  );

  const connection: ClaudeConnection = {
    agentId: CLAUDE_AGENT_ID,
    baseUrl,
    apiKey,
    hasApiKey: Boolean(apiKey),
    keyUnreadable: false,
    keyStorage: apiKey ? "plaintext" : "none",
    defaultModel: draft.defaultModel.trim(),
    models,
    modelsUpdatedAt: draft.models ? now : existing.modelsUpdatedAt,
    updatedAt: now,
  };

  // 保存即写标准文件；运行时直接复制，不再从数据库拼装
  writeConnectionFiles(connection);
  return toPublicConnection(connection);
}

// ============================================================================
// 本机配置探测
// ============================================================================

/** 本机 Claude 配置目录：与 CLI 保持一致，尊重 CLAUDE_CONFIG_DIR */
export function claudeConfigSourceDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function claudeOAuthCredentialsPath(): string {
  return join(claudeConfigSourceDir(), ".credentials.json");
}

export function hasOAuthCredentials(): boolean {
  return existsSync(claudeOAuthCredentialsPath());
}

export function isOfficialBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) return true;
  try {
    return new URL(trimmed).hostname.toLowerCase() === OFFICIAL_HOST;
  } catch {
    return false;
  }
}

/** 当前连接的认证方式，用于 UI 提示与运行审计 */
export function claudeAuthMode(conn: ClaudeConnection): ClaudeAuthMode {
  if (conn.apiKey) {
    return isOfficialBaseUrl(conn.baseUrl) ? "api-key" : "auth-token";
  }
  if (isOfficialBaseUrl(conn.baseUrl) && hasOAuthCredentials()) return "oauth-copy";
  return "none";
}

/** 注入节点子进程的环境变量（不含 CLAUDE_CONFIG_DIR，由调用方补） */
export function resolveClaudeEnv(conn: ClaudeConnection): Record<string, string> {
  const env: Record<string, string> = {};
  if (conn.baseUrl) env.ANTHROPIC_BASE_URL = conn.baseUrl;
  if (conn.apiKey) {
    // 官方端点用 x-api-key；第三方兼容端点统一走 Bearer
    if (isOfficialBaseUrl(conn.baseUrl)) env.ANTHROPIC_API_KEY = conn.apiKey;
    else env.ANTHROPIC_AUTH_TOKEN = conn.apiKey;
  }

  // 继承来的别名映射：让老员工里保存的 "sonnet" 之类的值仍能解析到实际模型
  for (const model of conn.models) {
    if (!model.alias) continue;
    env[`ANTHROPIC_DEFAULT_${model.alias.toUpperCase()}_MODEL`] = model.value;
  }
  return env;
}

/** 工作流启动前的前置校验 */
export function validateClaudeReadiness(): { ok: boolean; message: string } {
  const conn = getClaudeConnection();
  if (conn.apiKey) return { ok: true, message: "" };
  if (conn.keyUnreadable) {
    return {
      ok: false,
      message:
        "已保存的 Claude API Key 无法在当前设备解密（可能来自其他设备或备份还原），请到「运行环境 → Agent 配置」重新填写。",
    };
  }
  if (isOfficialBaseUrl(conn.baseUrl) && hasOAuthCredentials()) {
    return { ok: true, message: "" };
  }
  if (!isOfficialBaseUrl(conn.baseUrl)) {
    return {
      ok: false,
      message:
        "Claude 连接未配置 API Key：使用自定义 Base URL 时必须填写密钥。请到「运行环境 → Agent 配置」完成配置。",
    };
  }
  return {
    ok: false,
    message:
      "尚未配置 Claude 连接：请到「运行环境 → Agent 配置」填写 API Key，或先在本机完成 Claude Code 登录。",
  };
}

// ============================================================================
// 网络查询 / 连通性测试
// ============================================================================

function normalizeBase(baseUrl: string): string {
  return (baseUrl.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function modelsUrl(baseUrl: string): string {
  const base = normalizeBase(baseUrl);
  return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}

function messagesUrl(baseUrl: string): string {
  const base = normalizeBase(baseUrl);
  return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

/** 探测请求同时带两种认证头，兼容官方与主流第三方网关 */
function authHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
}

/** 把 Node fetch 的底层错误翻译成用户能看懂的提示 */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "AbortError") return "请求超时（8 秒）";

  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  switch (cause?.code) {
    case "ENOTFOUND":
      return "域名解析失败，请检查 Base URL";
    case "ECONNREFUSED":
      return "连接被拒绝，请检查 Base URL 与端口";
    case "ECONNRESET":
      return "连接被重置";
    case "ETIMEDOUT":
      return "连接超时";
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return "TLS 证书校验失败，请检查服务端证书";
    default:
      break;
  }
  if (cause?.message) return `${err.message}（${cause.message}）`;
  return err.message;
}

function errorSnippet(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: string };
      message?: string;
    };
    const message = parsed.error?.message || parsed.message;
    if (message) return `：${message}`;
  } catch {
    // 非 JSON：按纯文本截断
  }
  return `：${trimmed.slice(0, 200)}`;
}

function parseRemoteModels(payload: unknown): AgentModelOption[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  const options: AgentModelOption[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);

    const displayName =
      (item as { display_name?: unknown }).display_name ??
      (item as { name?: unknown }).name;
    options.push({
      value: id,
      label: typeof displayName === "string" && displayName ? displayName : id,
    });
  }
  return options;
}

interface FetchModelsResult {
  ok: boolean;
  models: AgentModelOption[];
  httpStatus?: number;
  message: string;
}

async function fetchClaudeModels(
  baseUrl: string,
  apiKey: string,
): Promise<FetchModelsResult> {
  if (!apiKey) {
    return { ok: false, models: [], message: "未提供 API Key" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(modelsUrl(baseUrl), {
      headers: authHeaders(apiKey),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        models: [],
        httpStatus: response.status,
        message: `${response.status} ${response.statusText}${errorSnippet(text)}`,
      };
    }
    const payload: unknown = await response.json();
    const models = parseRemoteModels(payload);
    return {
      ok: true,
      models,
      httpStatus: response.status,
      message: models.length
        ? `已获取 ${models.length} 个模型`
        : "接口可访问，但未返回任何模型",
    };
  } catch (err) {
    return {
      ok: false,
      models: [],
      message: describeFetchError(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 最小消息请求：应对不实现 /v1/models 的兼容端点 */
async function sendMinimalMessage(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; httpStatus?: number; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(messagesUrl(baseUrl), {
      method: "POST",
      headers: { ...authHeaders(apiKey), "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        httpStatus: response.status,
        message: `${response.status} ${response.statusText}${errorSnippet(text)}`,
      };
    }
    return { ok: true, httpStatus: response.status, message: "模型可用" };
  } catch (err) {
    return {
      ok: false,
      message: describeFetchError(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析表单 / 已保存值：表单里有就用表单的，否则回落到已保存配置 */
function resolveProbeTarget(input: AgentConnectionProbeInput): {
  baseUrl: string;
  apiKey: string;
  model: string;
} {
  const conn = getClaudeConnection();
  return {
    baseUrl: input.baseUrl.trim() || conn.baseUrl,
    apiKey: input.apiKey?.trim() ? input.apiKey.trim() : conn.apiKey,
    model: (input.model ?? conn.defaultModel).trim(),
  };
}

/** 只查询模型列表（页面的「查询模型」） */
export async function probeClaudeModels(
  input: AgentConnectionProbeInput,
): Promise<AgentConnectionProbeResult> {
  const started = Date.now();
  const target = resolveProbeTarget(input);
  if (!target.apiKey) {
    return {
      ok: false,
      latencyMs: 0,
      message:
        isOfficialBaseUrl(target.baseUrl) && hasOAuthCredentials()
          ? "本机 OAuth 凭证无法用于模型列表查询，请填写 API Key"
          : "请先填写 API Key",
    };
  }

  const result = await fetchClaudeModels(target.baseUrl, target.apiKey);
  if (result.ok && result.models.length > 0) {
    cacheClaudeModels(result.models);
  }
  return {
    ok: result.ok,
    latencyMs: Date.now() - started,
    httpStatus: result.httpStatus,
    message: result.message,
    models: result.models,
    modelVerified: null,
  };
}

/**
 * 连通性测试：Base URL + API Key + 模型名。
 *
 * 优先查 /v1/models 并确认模型在列表里；服务未实现该接口时，
 * 退化为一次 max_tokens=1 的最小消息请求（消耗极小，但能真实验证模型可用）。
 */
export async function testClaudeConnection(
  input: AgentConnectionProbeInput,
): Promise<AgentConnectionProbeResult> {
  const started = Date.now();
  const target = resolveProbeTarget(input);

  if (!target.apiKey) {
    return {
      ok: false,
      latencyMs: 0,
      message:
        isOfficialBaseUrl(target.baseUrl) && hasOAuthCredentials()
          ? "本机 OAuth 凭证只能用于实际运行，无法做接口连通性测试；请填写 API Key 后重试。"
          : "请先填写 API Key",
    };
  }

  const listed = await fetchClaudeModels(target.baseUrl, target.apiKey);
  let ok = listed.ok;
  let httpStatus = listed.httpStatus;
  let message = listed.message;
  let models = listed.models;
  let modelVerified: boolean | null = null;

  if (listed.ok && listed.models.length > 0) {
    cacheClaudeModels(listed.models);
  }

  if (target.model) {
    if (listed.models.length > 0) {
      modelVerified = listed.models.some((model) => model.value === target.model);
      if (!modelVerified) {
        ok = false;
        message = `连接正常，但模型「${target.model}」不在可用列表中，请确认模型名`;
      } else {
        message = `连接正常，模型「${target.model}」可用`;
      }
    } else {
      // 只有「接口明确不支持 /v1/models」或「接口可用但列表为空」时才退化到
      // 最小消息请求；网络 / 鉴权错误直接保留原错误，避免重复且误导的提示。
      const shouldProbe =
        listed.ok ||
        listed.httpStatus === 404 ||
        listed.httpStatus === 405;

      if (!shouldProbe) {
        modelVerified = null;
      } else {
        const probe = await sendMinimalMessage(
          target.baseUrl,
          target.apiKey,
          target.model,
        );
        modelVerified = probe.ok;
        if (probe.ok) {
          ok = true;
          httpStatus = probe.httpStatus ?? httpStatus;
          message = `模型「${target.model}」可用（该服务未提供 /v1/models，已通过最小请求验证）`;
        } else {
          ok = false;
          httpStatus = probe.httpStatus ?? httpStatus;
          message = listed.ok
            ? `接口可访问，但模型「${target.model}」验证失败：${probe.message}`
            : `${listed.message}；模型验证失败：${probe.message}`;
        }
      }
    }
  }

  return {
    ok,
    latencyMs: Date.now() - started,
    httpStatus,
    message,
    models,
    modelVerified,
  };
}

/** 把查询到的模型写入 models.json；还没有保存过连接时不创建文件 */
export function cacheClaudeModels(models: AgentModelOption[]): void {
  const existing = getClaudeConnection();

  // 页面上的表单可能还没保存；此时只在内存里展示，不提前创建配置文件
  if (!existsSync(claudeSettingsPath())) return;

  const merged = preserveModelAliases(models, existing.models);
  writeConnectionFiles({
    ...existing,
    models: merged,
    modelsUpdatedAt: Date.now(),
  });
}

// ============================================================================
// 从本机 Claude 配置一次性导入
// ============================================================================

function collectLocalModels(env: Record<string, string>): AgentModelOption[] {
  const result = new Map<string, AgentModelOption>();
  const add = (
    value: string,
    label: string,
    hint?: string,
    alias?: string,
  ) => {
    if (!value || result.has(value)) return;
    result.set(value, { value, label, hint, alias });
  };

  const direct = env.ANTHROPIC_MODEL?.trim();
  if (direct) add(direct, direct, "ANTHROPIC_MODEL");

  for (const alias of ALIASES) {
    const upper = alias.toUpperCase();
    const mapped = env[`ANTHROPIC_DEFAULT_${upper}_MODEL`]?.trim();
    const name = env[`ANTHROPIC_DEFAULT_${upper}_MODEL_NAME`]?.trim();
    const value = mapped || name;
    if (value) {
      add(
        value,
        name || `${alias} · ${value}`,
        `${alias} 别名映射`,
        alias,
      );
    }
  }

  return [...result.values()];
}

function mergeModels(
  existing: AgentModelOption[],
  imported: AgentModelOption[],
): AgentModelOption[] {
  const merged = new Map<string, AgentModelOption>();
  for (const model of existing) merged.set(model.value, model);

  for (const model of imported) {
    const current = merged.get(model.value);
    if (!current) {
      merged.set(model.value, model);
      continue;
    }
    // 已有条目可能来自远端查询（没有别名信息），用导入结果补全
    if (!current.alias && model.alias) {
      merged.set(model.value, {
        ...current,
        alias: model.alias,
        hint: current.hint ?? model.hint,
      });
    }
  }

  return [...merged.values()];
}

/**
 * 读取本机 `settings.json` 的 env，一次性写入 Nova。
 *
 * 只导入、不建立运行期依赖：导入完成后改动本机配置不会影响 Nova。
 */
export async function importLocalClaudeConnection(): Promise<AgentConnectionImportResult> {
  const sourceDir = claudeConfigSourceDir();
  const settingsPath = join(sourceDir, "settings.json");
  const warnings: string[] = [];

  let env: Record<string, string> = {};
  if (!existsSync(settingsPath)) {
    warnings.push(`未找到 ${settingsPath}，无法读取 Base URL / API Key。`);
  } else {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        env?: Record<string, unknown>;
      };
      if (parsed.env && typeof parsed.env === "object") {
        for (const [key, value] of Object.entries(parsed.env)) {
          if (typeof value === "string") env[key] = value;
        }
      }
    } catch (err) {
      warnings.push(
        `读取 ${settingsPath} 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 同时参考进程环境变量：有些用户把接入信息放在系统环境里
  for (const key of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    ...ALIASES.flatMap((alias) => {
      const upper = alias.toUpperCase();
      return [
        `ANTHROPIC_DEFAULT_${upper}_MODEL`,
        `ANTHROPIC_DEFAULT_${upper}_MODEL_NAME`,
      ];
    }),
  ]) {
    if (!env[key] && process.env[key]) env[key] = process.env[key]!;
  }

  const baseUrl = (env.ANTHROPIC_BASE_URL ?? "").trim();
  const apiKey = (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "").trim();
  let models = collectLocalModels(env);
  let defaultModel =
    (env.ANTHROPIC_MODEL ?? "").trim() || models[0]?.value || "";

  if (!baseUrl) warnings.push("本机配置未设置 ANTHROPIC_BASE_URL，将使用官方端点。");
  if (!apiKey) {
    warnings.push(
      hasOAuthCredentials()
        ? "本机配置未找到 API Key；检测到 OAuth 凭证，运行时会复制凭证副本。"
        : "本机配置未找到 API Key，请手动填写。",
    );
  }

  // 本机没有模型映射时，用导入的密钥尝试查询一次，自动补一个默认模型，
  // 避免导入后停在「未指定模型」的状态。
  if (models.length === 0 && apiKey) {
    const fetched = await fetchClaudeModels(baseUrl, apiKey);
    if (fetched.ok && fetched.models.length > 0) {
      models = fetched.models;
      defaultModel = models[0]?.value || "";
      warnings.push(
        `本机配置未找到模型映射，已从接口查询到 ${models.length} 个模型，并将第一个设为默认模型。`,
      );
    } else {
      warnings.push(
        `本机配置未找到模型映射，接口查询也失败（${fetched.message}），请在页面查询模型后保存。`,
      );
    }
  } else if (models.length === 0) {
    warnings.push("本机配置未找到模型映射，请手动查询模型。");
  }

  const existing = getClaudeConnection();
  const connection = saveClaudeConnection({
    agentId: CLAUDE_AGENT_ID,
    baseUrl: baseUrl || existing.baseUrl,
    defaultModel: defaultModel || existing.defaultModel,
    // 本机没有密钥时不要清掉 Nova 里已经保存的密钥
    apiKey: apiKey || undefined,
    models: models.length > 0 ? mergeModels(existing.models, models) : undefined,
  });

  return {
    connection,
    source: settingsPath,
    warnings,
    imported: {
      baseUrl: Boolean(baseUrl),
      apiKey: Boolean(apiKey),
      models: models.length,
    },
  };
}
