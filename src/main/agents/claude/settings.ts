/**
 * Claude 本机 settings.json 的读取 / 编辑
 *
 * 「Agent 平台」直接编辑这份文件，Claude CLI 与 Nova 共用同一套配置：
 * - env.ANTHROPIC_BASE_URL / AUTH_TOKEN / API_KEY
 * - env.ANTHROPIC_MODEL + ANTHROPIC_DEFAULT_*_MODEL
 * - permissions.defaultMode（终端 claude、Nova 会话与工作流节点共用；
 *   Nova 不再显式传 --permission-mode，完全交给 CLI 读取本机配置）
 *
 * 写入时只改上述键，保留 settings.json 里的其它内容（hooks / plugins / statusLine 等）。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import type {
  AgentModelAlias,
  AgentModelEntry,
  AgentSettingsDraft,
  AgentSettingsView,
} from "../../../shared/contracts/agent";
import { claudeSettingsPath } from "./config";

const ALIASES: readonly AgentModelAlias[] = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
];

function isOfficialBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) return true;
  try {
    return new URL(trimmed).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Base URL 只支持 http / https");
    }
  } catch {
    throw new Error("Base URL 不是合法地址，请填写完整的 http(s) 地址");
  }
  return trimmed;
}

function normalizePermissionMode(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "default";
  const trimmed = value.trim();
  // settings 里手动模式叫 default，命令行开关叫 manual
  return trimmed === "manual" ? "default" : trimmed;
}

function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 4) return "••••";
  return `••••${secret.slice(-4)}`;
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

/** 模型配置 → Claude 的模型 ID：`deepseek-flash` + `1M` → `deepseek-flash[1M]` */
function formatModelEntry(entry: AgentModelEntry): string {
  const name = entry.name.trim();
  const context = entry.context.trim();
  if (!name) return "";
  return context ? `${name}[${context}]` : name;
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
        err instanceof Error ? err.message : String(err)
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
  const temp = `${path}.nova-tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function readEnv(settings: Record<string, unknown>): Record<string, unknown> {
  return asRecord(settings.env);
}

export function getClaudeSettingsView(): AgentSettingsView {
  const { settings, exists } = readSettings();
  const env = readEnv(settings);
  const permissions = asRecord(settings.permissions);

  const apiKey =
    typeof env.ANTHROPIC_AUTH_TOKEN === "string"
      ? env.ANTHROPIC_AUTH_TOKEN
      : typeof env.ANTHROPIC_API_KEY === "string"
        ? env.ANTHROPIC_API_KEY
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

  return {
    agentId: "claude",
    settingsPath: claudeSettingsPath(),
    exists,
    baseUrl:
      typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : "",
    apiKey,
    hasApiKey: Boolean(apiKey),
    apiKeyHint: maskSecret(apiKey),
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

  // Base URL
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  else delete env.ANTHROPIC_BASE_URL;

  // API Key：undefined 保持、"" 清除、其他更新；并按端点类型放到正确的键
  const existingKey =
    typeof env.ANTHROPIC_AUTH_TOKEN === "string"
      ? env.ANTHROPIC_AUTH_TOKEN
      : typeof env.ANTHROPIC_API_KEY === "string"
        ? env.ANTHROPIC_API_KEY
        : "";
  const apiKey =
    draft.apiKey === undefined ? existingKey : draft.apiKey.trim();
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  if (apiKey) {
    if (isOfficialBaseUrl(baseUrl)) env.ANTHROPIC_API_KEY = apiKey;
    else env.ANTHROPIC_AUTH_TOKEN = apiKey;
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

  settings.env = env;

  // 默认权限档位（保留 permissions 里的其它字段）
  const permissions = asRecord(settings.permissions);
  permissions.defaultMode = normalizePermissionMode(draft.permissionMode);
  settings.permissions = permissions;

  writeSettings(settings);
  return getClaudeSettingsView();
}
