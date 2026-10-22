/**
 * Pi 的静态元数据
 *
 * 只描述「宿主需要知道的事」，不含任何实现细节。
 * Pi 支持 --session 恢复会话，会话数据存放在 CLI 侧的 JSONL 文件里，需要同步清理。
 *
 * options 里的 key 由本包自行定义，宿主只负责渲染与回传；
 * key → 命令行开关的映射在 index.ts 的 buildArgs 里，与这里一一对应。
 */

import type { AgentManifest } from "../../../shared/contracts/agent";

export const manifest: AgentManifest = {
  id: "pi",
  displayName: "Pi",
  order: 10,
  tone: "amber",
  capabilities: {
    resume: true,
    sessionCleanup: true,
  },
  options: [
    {
      key: "model",
      label: "模型",
      hint: "对应 pi 的 --model；留空则由 pi 自己决定",
      type: "model",
    },
    {
      key: "thinking",
      label: "思考档位",
      hint: "对应 pi 的 --thinking；留空则由 pi 自己决定",
      type: "text",
    },
  ],
};
