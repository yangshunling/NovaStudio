/**
 * 按 Base URL / API Key 拉取模型列表
 *
 * Anthropic 兼容服务通常提供 GET /v1/models，返回 { data: [{ id, display_name }] }。
 * 请求在主进程发出，避免渲染进程的 CORS 限制；不缓存结果，
 * 由调用方在需要时（打开模型下拉、配置加载完成）重新获取。
 */

import type { AgentModelOption } from "../../../shared/contracts/agent";

const OFFICIAL_BASE_URL = "https://api.anthropic.com";
const REQUEST_TIMEOUT_MS = 15_000;

function isOfficialBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) return true;
  try {
    return new URL(trimmed).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
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

export async function listClaudeModels(
  baseUrl: string,
  apiKey: string,
): Promise<AgentModelOption[]> {
  const key = apiKey.trim();
  if (!key) throw new Error("请先填写 API Key，再获取模型列表");

  const official = isOfficialBaseUrl(baseUrl);
  const headers: Record<string, string> = {
    accept: "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (official) {
    headers["x-api-key"] = key;
  } else {
    // 自定义端点沿用 Claude Code 的 AUTH_TOKEN 约定（Bearer）；
    // 同时附带 x-api-key，兼容只认其中一种鉴权头的网关。
    headers.Authorization = `Bearer ${key}`;
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
