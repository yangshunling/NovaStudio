/**
 * OpenCode 的模型列表
 *
 * `opencode models` 按行输出可用模型（通常是 provider/model）。
 * 这里不假设固定列数：取每行第一个非空 token 作为 --model 的值，
 * 并把整行作为展示名；失败时由宿主回退为手动输入。
 */

import type { AgentModelOption } from "../../../shared/contracts/agent";
import { execCli } from "../transport";

const BIN = "opencode";
const LIST_TIMEOUT_MS = 15_000;

export async function listModels(): Promise<AgentModelOption[]> {
  const stdout = await execCli([BIN, "models"], LIST_TIMEOUT_MS);
  const options: AgentModelOption[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 跳过表头 / 分隔线
    if (/^provider\b/i.test(trimmed) && /model/i.test(trimmed)) continue;
    if (/^[-=]+$/.test(trimmed)) continue;

    const value = trimmed.split(/\s+/)[0];
    if (!value || seen.has(value)) continue;
    seen.add(value);

    options.push({
      value,
      label: trimmed === value ? value : trimmed,
    });
  }

  return options;
}
