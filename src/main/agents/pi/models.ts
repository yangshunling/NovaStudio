/**
 * Pi 的模型列表
 *
 * `pi --list-models` 输出一张按列对齐的表格：
 *
 *   provider             model                       context  max-out  thinking  images
 *   anthropic            claude-sonnet-5             1M       128K     yes       yes
 *   gateway              glm-5.2                     1M       16.4K    yes       no
 *
 * 列之间用两个以上空格分隔；按 provider/model 作为 --model 的值
 * （pi 的 help 明确支持 "provider/id"）。
 */

import type { AgentModelOption } from "../../../shared/contracts/agent";
import { execCli } from "../transport";

const BIN = "pi";
const LIST_TIMEOUT_MS = 15_000;

export async function listModels(): Promise<AgentModelOption[]> {
  const stdout = await execCli([BIN, "--list-models"], LIST_TIMEOUT_MS);
  const options: AgentModelOption[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s{2,}/);
    const [provider, model, context, maxOut] = columns;
    if (!provider || !model) continue;
    // 跳过表头
    if (provider.toLowerCase() === "provider" && model.toLowerCase() === "model") {
      continue;
    }

    const value = `${provider}/${model}`;
    if (seen.has(value)) continue;
    seen.add(value);

    const hint = [context && `上下文 ${context}`, maxOut && `输出 ${maxOut}`]
      .filter(Boolean)
      .join(" · ");

    options.push({
      value,
      label: `${model}（${provider}）`,
      hint: hint || provider,
    });
  }

  return options;
}
