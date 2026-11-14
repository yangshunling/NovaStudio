/**
 * 按 Base URL / API Key 拉取模型列表
 *
 * Anthropic 兼容服务通常提供 GET /v1/models，返回 { data: [{ id, display_name }] }。
 * 请求在主进程发出，避免渲染进程的 CORS 限制；不缓存结果，
 * 由调用方在需要时（打开模型下拉、配置加载完成）重新获取。
 */

import type {
  AgentAuthMode,
  AgentModelEntry,
  AgentModelListResult,
  AgentModelOption,
} from "../../../shared/contracts/agent";
import { isOfficialBaseUrl, stripApiEndpoint } from "./config";

const OFFICIAL_BASE_URL = "https://api.anthropic.com";
const REQUEST_TIMEOUT_MS = 15_000;

/** 模型配置 → 展示 / 环境变量用的 ID：`deepseek-flash` + `1M` → `deepseek-flash[1M]` */
export function formatModelEntry(entry: AgentModelEntry): string {
  const name = entry.name.trim();
  if (!name) return "";
  const context = entry.context.trim();
  return context ? `${name}[${context}]` : name;
}

function errorMessageOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as Record<string, unknown>).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return null;
}

function parseModels(payload: unknown): AgentModelOption[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("模型列表响应格式不正确");
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new Error("模型列表响应缺少 data 数组");
  }

  const seen = new Set<string>();
  const models: AgentModelOption[] = [];
  for (const item of data) {
    // 兼容 Anthropic（对象）与部分网关（纯字符串数组）两种返回
    const id =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? (item as Record<string, unknown>).id
          : "";
    if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;

    const displayName =
      item && typeof item === "object"
        ? (item as Record<string, unknown>).display_name
        : undefined;
    seen.add(id);
    models.push({
      id,
      ...(typeof displayName === "string" && displayName.trim()
        ? { displayName: displayName.trim() }
        : {}),
    });
  }
  return models;
}

/**
 * 解析 `ANTHROPIC_CUSTOM_HEADERS`：每行一个 `Name: Value`。
 * 与 Claude Code 的格式保持一致；空行与 # 注释行忽略。
 */
export function parseCustomHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf(":");
    if (index <= 0) continue;
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

/**
 * 列出模型列表的候选地址。
 *
 * 兼容性处理：
 * - Base URL 已带 `/v1`：只请求 `/models`，避免拼成 `/v1/v1/models`；
 * - 误粘贴完整接口地址（`/v1/messages` 等）：还原成根路径后再拼；
 * - 除标准的 `/v1/models` 外，再兜底试一次根路径 `/models`——
 *   部分 Anthropic 兼容网关把模型列表放在根路径下。
 */
export function modelsUrlCandidates(baseUrl: string): string[] {
  const root = baseUrl.trim() || OFFICIAL_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(root);
  } catch {
    throw new Error("Base URL 不是合法地址，请填写完整的 http(s) 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL 只支持 http / https");
  }

  parsed.search = "";
  parsed.hash = "";
  const path = stripApiEndpoint(parsed.pathname);
  const base = `${parsed.origin}${path === "/" ? "" : path}`;
  const candidates = /\/v1$/i.test(path)
    ? [`${base}/models?limit=1000`]
    : [`${base}/v1/models?limit=1000`, `${base}/models?limit=1000`];

  /*
   * 厂商的 Anthropic 兼容入口通常只代理 `/v1/messages`
   * （例如 DeepSeek 的 `https://api.deepseek.com/anthropic`），
   * 不提供 `/anthropic/v1/models`。这类厂商的模型列表一般挂在
   * 根路径的 OpenAI 兼容接口上，因此再回退到去掉 `/anthropic`
   * 之后的父路径试一次。
   */
  const anthropicRoot = path.match(/^(.*)\/anthropic$/i);
  if (anthropicRoot) {
    const root = `${parsed.origin}${anthropicRoot[1]}`;
    candidates.push(
      `${root}/v1/models?limit=1000`,
      `${root}/models?limit=1000`,
    );
  }

  return [...new Set(candidates)];
}

export async function listClaudeModels(
  baseUrl: string,
  apiKey: string,
  authMode?: AgentAuthMode,
  customHeaders?: string,
): Promise<AgentModelListResult> {
  const key = apiKey.trim();
  // 鉴权方式必须和 CLI 实际发送的请求头一致；本次请求只发一种，
  // 避免“列表能拉到但运行时 401”的假阳性。
  const mode: AgentAuthMode =
    authMode ?? (isOfficialBaseUrl(baseUrl) ? "api-key" : "auth-token");

  if (mode === "api-key-helper") {
    return {
      models: [],
      unsupported:
        "apiKeyHelper 由本机脚本提供 Key，页面无法代其请求模型列表；模型名可直接手动输入",
    };
  }
  if (!key) throw new Error("请先填写 API Key，再获取模型列表");

  const headers: Record<string, string> = {
    accept: "application/json",
    "anthropic-version": "2023-06-01",
    ...parseCustomHeaders(customHeaders ?? ""),
  };
  if (mode === "auth-token") {
    headers.Authorization = `Bearer ${key}`;
  } else {
    headers["x-api-key"] = key;
  }

  const candidates = modelsUrlCandidates(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    for (const url of candidates) {
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      });

      /*
       * 404 / 405 表示这个接入点没有模型列表接口（或不允许 GET）。
       * 模型列表不是 Anthropic 协议的一部分，Claude Code 运行时也
       * 不依赖它，因此换下一个候选地址继续探测即可。
       */
      if (response.status === 404 || response.status === 405) continue;

      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = errorMessageOf(payload);
        throw new Error(
          detail
            ? `获取模型列表失败：${detail}`
            : `获取模型列表失败：HTTP ${response.status}`,
        );
      }

      try {
        return { models: parseModels(payload) };
      } catch {
        // 200 但不是模型列表（网关兜底页 / 空响应）：继续试下一个地址
      }
    }

    const tried = candidates
      .map((url) => new URL(url).pathname)
      .join("、");
    return {
      models: [],
      unsupported: `该接入点未提供模型列表接口（已尝试 ${tried}），模型名可直接手动输入`,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("获取模型列表超时，请检查 Base URL 是否可访问");
    }
    if (error instanceof Error) throw error;
    throw new Error(`获取模型列表失败：${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}
