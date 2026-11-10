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
  AgentModelOption,
} from "../../../shared/contracts/agent";
import { isOfficialBaseUrl } from "./config";

const OFFICIAL_BASE_URL = "https://api.anthropic.com";
const REQUEST_TIMEOUT_MS = 15_000;

/** 模型配置 → 展示 / 环境变量用的 ID：`deepseek-flash` + `1M` → `deepseek-flash[1M]` */
export function formatModelEntry(entry: AgentModelEntry): string {
  const name = entry.name.trim();
  if (!name) return "";
  const context = entry.context.trim();
  return context ? `${name}[${context}]` : name;
}

/** 兼容 Base URL 已带 /v1 的写法，避免拼成 /v1/v1/models */
function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const root = trimmed || OFFICIAL_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(root);
  } catch {
    throw new Error("Base URL 不是合法地址，请填写完整的 http(s) 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL 只支持 http / https");
  }
  const base = /\/v1$/i.test(root) ? root : `${root}/v1`;
  return `${base}/models?limit=1000`;
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

export async function listClaudeModels(
  baseUrl: string,
  apiKey: string,
  authMode?: AgentAuthMode,
  customHeaders?: string,
): Promise<AgentModelOption[]> {
  const key = apiKey.trim();
  // 鉴权方式必须和 CLI 实际发送的请求头一致；本次请求只发一种，
  // 避免“列表能拉到但运行时 401”的假阳性。
  const mode: AgentAuthMode =
    authMode ?? (isOfficialBaseUrl(baseUrl) ? "api-key" : "auth-token");

  if (mode === "api-key-helper") {
    throw new Error(
      "apiKeyHelper 由本机脚本提供 Key，页面无法代其请求模型列表",
    );
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(modelsUrl(baseUrl), {
      headers,
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = errorMessageOf(payload);
      throw new Error(
        detail
          ? `获取模型列表失败：${detail}`
          : `获取模型列表失败：HTTP ${response.status}`,
      );
    }
    return parseModels(payload);
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
