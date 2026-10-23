/**
 * Codex 的静态元数据
 *
 * Codex 支持 `codex exec resume <thread_id>` 恢复会话，会话数据存放在 CLI 侧
 * （rollout 文件），需要同步清理。
 *
 * options 里的 key 由本包自行定义，宿主只负责渲染与回传；
 * key → 命令行开关的映射在 index.ts 的 OPTION_FLAGS 里，与这里一一对应。
 */

import type { AgentManifest } from "../../../shared/contracts/agent";

export const manifest: AgentManifest = {
  id: "codex",
  displayName: "Codex",
  order: 40,
  tone: "teal",
  capabilities: {
    resume: true,
    sessionCleanup: true,
    skills: false,
    mcp: false,
  },
  options: [
    {
      key: "model",
      label: "模型",
      hint: "对应 codex 的 -m/--model；留空则由 codex 自己决定",
      type: "model",
    },
    {
      key: "sandbox",
      label: "沙箱策略",
      hint: "对应 codex 的 -s/--sandbox；留空 = 完全放开（跳过审批且不使用沙箱，最高权限）。可选：read-only / workspace-write / danger-full-access",
      type: "select",
      choices: ["read-only", "workspace-write", "danger-full-access"],
    },
  ],
};
