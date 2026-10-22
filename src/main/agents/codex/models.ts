/**
 * Codex 的模型列表
 *
 * `codex debug models` 输出官方模型目录 JSON：
 *   { "models": [{ "slug": "gpt-6-astra", "display_name": "GPT-6-Astra",
 *                  "visibility": "list", "priority": 2, ... }] }
 *
 * 只保留 visibility != "hide" 的条目，并按 priority 升序。
 */

import type { AgentModelOption } from "../../../shared/contracts/agent";
import { execCli } from "../transport";

const BIN = "codex";
const LIST_TIMEOUT_MS = 15_000;

interface CodexModelCatalog {
  models?: Array<{
    slug?: unknown;
    display_name?: unknown;
    description?: unknown;
    visibility?: unknown;
    priority?: unknown;
  }>;
}

export async function listModels(): Promise<AgentModelOption[]> {
  const stdout = await execCli([BIN, "debug", "models"], LIST_TIMEOUT_MS);
  const payload = JSON.parse(stdout) as CodexModelCatalog;
  const models = Array.isArray(payload.models) ? payload.models : [];

  return models
    .filter(
      (model) =>
        typeof model.slug === "string" &&
        model.slug.length > 0 &&
        model.visibility !== "hide",
    )
    .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
    .map((model) => ({
      value: model.slug as string,
      label:
        typeof model.display_name === "string" && model.display_name
          ? model.display_name
          : (model.slug as string),
      hint:
        typeof model.description === "string" ? model.description : undefined,
    }));
}
