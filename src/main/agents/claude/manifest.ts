/**
 * Claude Code 的静态元数据
 *
 * Claude Code 支持 --resume 恢复会话，会话数据存放在 CLI 侧的 JSONL 文件里，
 * 需要同步清理。
 *
 * options 里的 key 由本包自行定义，宿主只负责渲染与回传；
 * key → 命令行开关的映射在 index.ts 的 OPTION_FLAGS 里，与这里一一对应。
 */

import type { AgentManifest } from "../../../shared/contracts/agent";

export const manifest: AgentManifest = {
  id: "claude",
  displayName: "Claude Code",
  order: 30,
  tone: "sky",
  capabilities: {
    resume: true,
    sessionCleanup: true,
    skills: true,
    mcp: true,
  },
  installCommand: "npm install -g @anthropic-ai/claude-code",
  options: [
    {
      key: "permissionMode",
      label: "权限模式",
      hint: "对应 claude 的 --permission-mode；留空 = bypassPermissions（最高权限，不弹授权）。manual 每次询问 / acceptEdits 自动接受编辑 / plan 只读规划 / auto 分类器放行 / dontAsk 未预授权即拒绝 / bypassPermissions 全部放行",
      type: "select",
      // 取值以本机 claude --help 列出的 choices 为准：
      // acceptEdits / auto / bypassPermissions / manual / dontAsk / plan
      // （注意这里是 manual —— settings 里 Manual 的配置值叫 default，但命令行开关认的是 manual）
      choices: ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
    },
  ],
};
