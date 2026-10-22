/**
 * Claude Code 的模型列表
 *
 * Claude Code 没有 `models` 子命令，但它的模型来自所配置的 Anthropic 兼容接口：
 * - 配置优先取 `~/.claude/settings.json` 的 env（Claude Code 自己也是这么读的）
 * - 环境变量优先于配置文件
 * - 向 `${ANTHROPIC_BASE_URL}/v1/models` 查询模型列表
 *
 * 若没有凭据或接口不可用，回退到 Claude Code 的四个内置别名
 * （fable / opus / sonnet / haiku）。这些别名由 CLI 自己映射到具体模型，
 * 因此即使接口查不到，下拉里仍然有可选项。
 *
 * 注意：凭据只用于本次请求，不落盘、不打印。
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AgentModelOption } from "../../../shared/contracts/agent";

const ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;
const FETCH_TIMEOUT_MS = 6000;

interface ClaudeSettings {
  env?: Record<string, unknown>;
}

/** 读取 Claude Code 配置文件里的 env（不读取用户目录之外的内容） */
function readSettingsEnv(): Record<string, string> {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    const raw = readFileSync(join(configDir, "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as ClaudeSettings;
    const env = parsed.env;
    if (!env || typeof env !== "object") return {};

    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** 配置文件 + 进程环境变量，后者优先 */
function resolveEnv(): Record<string, string> {
  const env = readSettingsEnv();
  const keys = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    ...ALIASES.map((alias) => `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`),
    ...ALIASES.map(
      (alias) => `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL_NAME`,
    ),
  ];

  for (const key of keys) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/** 查询 Anthropic 兼容接口的 /v1/models；失败返回空数组 */
async function fetchRemoteModels(
  baseUrl: string,
  token: string,
): Promise<AgentModelOption[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-api-key": token,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    if (!Array.isArray(payload.data)) return [];

    const options: AgentModelOption[] = [];
    const seen = new Set<string>();
    for (const item of payload.data) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      seen.add(id);
      options.push({ value: id, label: id });
    }
    return options;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** 接口不可用时的别名兜底；映射名来自 Claude Code 的 ANTHROPIC_DEFAULT_* */
function aliasOptions(env: Record<string, string>): AgentModelOption[] {
  return ALIASES.map((alias) => {
    const upper = alias.toUpperCase();
    const mapped = env[`ANTHROPIC_DEFAULT_${upper}_MODEL`];
    const name = env[`ANTHROPIC_DEFAULT_${upper}_MODEL_NAME`];
    const detail = name || mapped;
    return {
      value: alias,
      label: detail && detail !== alias ? `${alias} · ${detail}` : alias,
      hint: mapped && mapped !== alias ? `映射到 ${mapped}` : undefined,
    };
  });
}

export async function listModels(): Promise<AgentModelOption[]> {
  const env = resolveEnv();
  const baseUrl = env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;

  if (token) {
    const remote = await fetchRemoteModels(baseUrl, token);
    if (remote.length > 0) return remote;
  }

  return aliasOptions(env);
}
