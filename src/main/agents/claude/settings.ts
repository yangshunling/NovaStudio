/**
 * Claude 本机 settings.json 的读取 / 编辑
 *
 * 「Agent 平台」直接编辑这份文件，Claude CLI 与 Nova 共用同一套配置：
 * - env.ANTHROPIC_BASE_URL / AUTH_TOKEN / API_KEY
 * - env.ANTHROPIC_MODEL + ANTHROPIC_DEFAULT_*_MODEL
 * - permissions.defaultMode（作为 Nova 新会话与工作流节点的默认值；
 *   会话工具栏可以按会话覆盖，覆盖值通过 --permission-mode 显式传入，
 *   不再写回本文件）
 *
 * 写入时只改上述键，保留 settings.json 里的其它内容（hooks / plugins / statusLine 等）。
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { writeFileAtomicSync } from "../../utils/fs";
import {
  AGENT_MODEL_ALIASES,
  type AgentAuthMode,
  type AgentModelAlias,
  type AgentModelEntry,
  type AgentProvider,
  type AgentSettingsDraft,
  type AgentSettingsView,
} from "../../../shared/contracts/agent";
import {
  claudeSettingsPath,
  isOfficialBaseUrl,
  stripApiEndpoint,
} from "./config";
import { formatModelEntry } from "./models";
import { errorMessage } from "../../../shared/error";
import { DEFAULT_PERMISSION_MODE } from "../../../shared/permission";

const ALIASES = AGENT_MODEL_ALIASES;

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
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
  // 清掉查询串 / 锚点，并还原误粘贴的完整接口地址
  // （Claude CLI 会自己在根地址后拼 /v1/messages）
  parsed.search = "";
  parsed.hash = "";
  const path = stripApiEndpoint(parsed.pathname);
  return `${parsed.origin}${path === "/" ? "" : path}`;
}

function normalizePermissionMode(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_PERMISSION_MODE;
  }
  const trimmed = value.trim();
  // settings 里手动模式叫 default，命令行开关叫 manual
  return trimmed === "manual" ? "default" : trimmed;
}

function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 4) return "••••";
  return `••••${secret.slice(-4)}`;
}

/** 读取 env 里的字符串配置；非字符串一律视为未设置 */
function readEnvString(
  env: Record<string, unknown>,
  key: string,
): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Claude Code 用同一套规则判断开关：空串 / "0" / "false" 视为关闭。
 * 这里保持一致，避免页面上显示已开启、CLI 实际没开。
 */
function isEnvEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * 从 provider 开关推导当前接入方式。
 *
 * Claude Code 的优先级（见 CLI 的 provider 判定）：
 * Bedrock / Vertex / Foundry 互斥，都不设时走 ANTHROPIC_BASE_URL。
 */
function readProvider(env: Record<string, unknown>): AgentProvider {
  if (isEnvEnabled(env.CLAUDE_CODE_USE_BEDROCK)) return "bedrock";
  if (isEnvEnabled(env.CLAUDE_CODE_USE_VERTEX)) return "vertex";
  if (isEnvEnabled(env.CLAUDE_CODE_USE_FOUNDRY)) return "foundry";
  return "anthropic";
}

/** 校验正整数配置（毫秒 / token 数），空串表示清除 */
function normalizePositiveInt(
  value: string | undefined,
  label: string,
  envKey: string,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new Error(`${label} 必须是正整数（写入 ${envKey}）`);
  }
  return String(Number(trimmed));
}

/** 写入 env 字符串：undefined = 不动，空串 = 删除 */
function writeEnvString(
  env: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (trimmed) env[key] = trimmed;
  else delete env[key];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 解析模型 ID：`deepseek-flash[1M]` → { name: "deepseek-flash", context: "1M" }
 *
 * 上下文后缀只是模型 ID 的一部分约定，不是模型名本身。
 */
function parseModelEntry(
  rawModel: unknown,
  rawName: unknown = "",
): AgentModelEntry {
  const model = typeof rawModel === "string" ? rawModel.trim() : "";
  const fallbackName = typeof rawName === "string" ? rawName.trim() : "";

  if (model) {
    const match = /^(.*)\[([^\[\]]+)\]$/.exec(model);
    const name = (match?.[1] ?? model).trim();
    const context = match?.[2]?.trim() ?? "";
    return name
      ? { name, context }
      : { name: fallbackName, context };
  }

  return { name: fallbackName, context: "" };
}

function uniqueModelCount(
  entries: readonly AgentModelEntry[],
): number {
  return new Set(
    entries.map((entry) => entry.name.trim()).filter(Boolean),
  ).size;
}

interface SettingsFile {
  settings: Record<string, unknown>;
  exists: boolean;
}

function readSettings(): SettingsFile {
  const path = claudeSettingsPath();
  if (!existsSync(path)) {
    return { settings: {}, exists: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `~/.claude/settings.json 无法解析：${
        errorMessage(err)
      }`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("~/.claude/settings.json 格式不正确，已拒绝写入");
  }

  return { settings: parsed as Record<string, unknown>, exists: true };
}

function writeSettings(settings: Record<string, unknown>): void {
  const path = claudeSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomicSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function readEnv(settings: Record<string, unknown>): Record<string, unknown> {
  return asRecord(settings.env);
}

export function getClaudeSettingsView(): AgentSettingsView {
  const { settings, exists } = readSettings();
  const env = readEnv(settings);
  const permissions = asRecord(settings.permissions);

  const authToken = readEnvString(env, "ANTHROPIC_AUTH_TOKEN");
  const apiKeyEnv = readEnvString(env, "ANTHROPIC_API_KEY");
  const apiKey = authToken || apiKeyEnv;

  const apiKeyHelper =
    typeof settings.apiKeyHelper === "string"
      ? settings.apiKeyHelper.trim()
      : "";

  const defaultModel = parseModelEntry(env.ANTHROPIC_MODEL);

  const modelAliases = Object.fromEntries(
    ALIASES.map((alias) => {
      const upper = alias.toUpperCase();
      return [
        alias,
        parseModelEntry(
          env[`ANTHROPIC_DEFAULT_${upper}_MODEL`],
          env[`ANTHROPIC_DEFAULT_${upper}_MODEL_NAME`],
        ),
      ];
    }),
  ) as Record<AgentModelAlias, AgentModelEntry>;

  const authMode: AgentAuthMode = apiKeyHelper
    ? "api-key-helper"
    : authToken
      ? "auth-token"
      : "api-key";

  return {
    agentId: "claude",
    settingsPath: claudeSettingsPath(),
    exists,
    baseUrl: readEnvString(env, "ANTHROPIC_BASE_URL"),
    apiKey,
    hasApiKey: Boolean(apiKey),
    apiKeyHint: maskSecret(apiKey),
    provider: readProvider(env),
    authMode,
    apiKeyHelper,
    customHeaders: readEnvString(env, "ANTHROPIC_CUSTOM_HEADERS"),
    httpsProxy: readEnvString(env, "HTTPS_PROXY"),
    noProxy: readEnvString(env, "NO_PROXY"),
    apiTimeoutMs: readEnvString(env, "API_TIMEOUT_MS"),
    maxOutputTokens: readEnvString(env, "CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
    maxThinkingTokens: readEnvString(env, "MAX_THINKING_TOKENS"),
    disableNonessentialTraffic: isEnvEnabled(
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    ),
    bedrockRegion: readEnvString(env, "AWS_REGION"),
    bedrockBaseUrl: readEnvString(env, "ANTHROPIC_BEDROCK_BASE_URL"),
    vertexProjectId: readEnvString(env, "ANTHROPIC_VERTEX_PROJECT_ID"),
    vertexRegion: readEnvString(env, "CLOUD_ML_REGION"),
    vertexBaseUrl: readEnvString(env, "ANTHROPIC_VERTEX_BASE_URL"),
    foundryResource: readEnvString(env, "ANTHROPIC_FOUNDRY_RESOURCE"),
    foundryBaseUrl: readEnvString(env, "ANTHROPIC_FOUNDRY_BASE_URL"),
    defaultModel,
    modelAliases,
    modelCount: uniqueModelCount([
      defaultModel,
      ...Object.values(modelAliases),
    ]),
    permissionMode: normalizePermissionMode(permissions.defaultMode),
  };
}

export function saveClaudeSettings(
  draft: AgentSettingsDraft,
): AgentSettingsView {
  if (draft.agentId !== "claude") {
    throw new Error(`当前仅支持编辑 Claude Code 的本机配置（收到：${draft.agentId}）`);
  }

  const { settings } = readSettings();
  const env = readEnv(settings);
  const baseUrl = normalizeBaseUrl(draft.baseUrl);

  // Base URL（只对 anthropic 端点生效；其它 provider 走各自的专用变量）
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  else delete env.ANTHROPIC_BASE_URL;

  // 接入方式：三个 provider 开关互斥，anthropic 时全部清除
  if (draft.provider !== undefined) {
    const providerKeys = {
      bedrock: "CLAUDE_CODE_USE_BEDROCK",
      vertex: "CLAUDE_CODE_USE_VERTEX",
      foundry: "CLAUDE_CODE_USE_FOUNDRY",
    } as const;
    for (const [provider, key] of Object.entries(providerKeys)) {
      if (draft.provider === provider) env[key] = "1";
      else delete env[key];
    }
  }

  // API Key：undefined 保持、"" 清除、其他更新。
  // authMode 决定落点是 x-api-key 还是 Bearer；apiKeyHelper 模式下不写 env。
  const existingKey =
    readEnvString(env, "ANTHROPIC_AUTH_TOKEN") ||
    readEnvString(env, "ANTHROPIC_API_KEY");
  const apiKey =
    draft.apiKey === undefined ? existingKey : draft.apiKey.trim();
  const authMode: AgentAuthMode =
    draft.authMode ?? (isOfficialBaseUrl(baseUrl) ? "api-key" : "auth-token");

  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  if (authMode !== "api-key-helper" && apiKey) {
    // ANTHROPIC_API_KEY → 请求头 x-api-key；ANTHROPIC_AUTH_TOKEN → Authorization: Bearer
    env[
      authMode === "auth-token"
        ? "ANTHROPIC_AUTH_TOKEN"
        : "ANTHROPIC_API_KEY"
    ] = apiKey;
  }

  if (draft.authMode !== undefined) {
    const helper = (draft.apiKeyHelper ?? "").trim();
    if (authMode === "api-key-helper") {
      if (!helper) {
        throw new Error("选择 apiKeyHelper 时必须填写输出 API Key 的命令");
      }
      // apiKeyHelper 是 settings.json 顶层字段，不在 env 里
      settings.apiKeyHelper = helper;
    } else {
      delete settings.apiKeyHelper;
    }
  }

  // 默认模型：模型名与上下文分开，保存时重新拼成 model[context]
  const defaultModel = formatModelEntry(draft.defaultModel);
  if (defaultModel) env.ANTHROPIC_MODEL = defaultModel;
  else delete env.ANTHROPIC_MODEL;

  // 别名映射：_MODEL 存完整 ID（含上下文），_MODEL_NAME 只存基础模型名
  for (const alias of ALIASES) {
    const upper = alias.toUpperCase();
    const entry = draft.modelAliases[alias] ?? { name: "", context: "" };
    const name = entry.name.trim();
    const modelKey = `ANTHROPIC_DEFAULT_${upper}_MODEL`;
    const nameKey = `ANTHROPIC_DEFAULT_${upper}_MODEL_NAME`;

    if (name) {
      env[modelKey] = formatModelEntry(entry);
      env[nameKey] = name;
    } else {
      delete env[modelKey];
      delete env[nameKey];
    }
  }

  // === 以下配置全部来自 Claude Code 自身的 env 约定 ===
  // 自定义请求头：每行一个 `Name: Value`，Claude Code 会原样附加到请求上
  writeEnvString(env, "ANTHROPIC_CUSTOM_HEADERS", draft.customHeaders);

  // 网络：Claude Code 直接读取标准代理变量；API_TIMEOUT_MS 单位是毫秒
  writeEnvString(env, "HTTPS_PROXY", draft.httpsProxy);
  writeEnvString(env, "NO_PROXY", draft.noProxy);
  writeEnvString(
    env,
    "API_TIMEOUT_MS",
    normalizePositiveInt(draft.apiTimeoutMs, "API 超时", "API_TIMEOUT_MS"),
  );

  // 运行限制
  writeEnvString(
    env,
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    normalizePositiveInt(
      draft.maxOutputTokens,
      "最大输出 token",
      "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    ),
  );
  writeEnvString(
    env,
    "MAX_THINKING_TOKENS",
    normalizePositiveInt(
      draft.maxThinkingTokens,
      "最大思考 token",
      "MAX_THINKING_TOKENS",
    ),
  );
  if (draft.disableNonessentialTraffic !== undefined) {
    if (draft.disableNonessentialTraffic) {
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    } else {
      delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    }
  }

  // 云厂商专属参数：切换 provider 时保留，切回来不用重填
  writeEnvString(env, "AWS_REGION", draft.bedrockRegion);
  writeEnvString(env, "ANTHROPIC_BEDROCK_BASE_URL", draft.bedrockBaseUrl);
  writeEnvString(env, "ANTHROPIC_VERTEX_PROJECT_ID", draft.vertexProjectId);
  writeEnvString(env, "CLOUD_ML_REGION", draft.vertexRegion);
  writeEnvString(env, "ANTHROPIC_VERTEX_BASE_URL", draft.vertexBaseUrl);
  writeEnvString(env, "ANTHROPIC_FOUNDRY_RESOURCE", draft.foundryResource);
  writeEnvString(env, "ANTHROPIC_FOUNDRY_BASE_URL", draft.foundryBaseUrl);

  settings.env = env;

  // 默认权限档位（保留 permissions 里的其它字段）
  const permissions = asRecord(settings.permissions);
  permissions.defaultMode = normalizePermissionMode(draft.permissionMode);
  settings.permissions = permissions;

  writeSettings(settings);
  return getClaudeSettingsView();
}
