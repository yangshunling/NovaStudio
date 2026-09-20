/**
 * OpenCode 的静态元数据
 *
 * 会话数据存放在 OpenCode 自己的数据库里，需要同步清理。
 *
 * options 里的 key 由本包自行定义，宿主只负责渲染与回传；
 * key → 命令行开关的映射在 index.ts 的 OPTION_FLAGS 里，与这里一一对应。
 */

import type { AgentManifest } from "../../../shared/contracts/agent";

export const manifest: AgentManifest = {
  id: "opencode",
  displayName: "OpenCode",
  order: 20,
  tone: "violet",
  capabilities: {
    resume: true,
    sessionCleanup: true,
  },
  options: [
    {
      key: "model",
      label: "模型",
      hint: "对应 opencode 的 -m，格式为 provider/model；留空则由 opencode 自己决定",
      type: "text",
    },
    {
      key: "thinking",
      label: "思考档位",
      hint: "对应 opencode 的 --variant；留空则由 opencode 自己决定",
      type: "text",
    },
  ],
};
