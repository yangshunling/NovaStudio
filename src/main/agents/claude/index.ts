/**
 * Claude Code provider
 *
 * Claude Code 是 Anthropic 的终端 AI 编码智能体。
 * 支持 stream-json 流式事件输出与 --resume 会话恢复。
 *
 * CLI 用法（claude 2.1.273，基于 --help 与实跑输出确认）：
 *   首次调用：claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages
 *   恢复会话：claude -p "<prompt>" --resume <session_id> --output-format stream-json --verbose ...
 *   检测安装：claude --version
 *   工作目录：claude 无 -C 选项，通过进程的 cwd 设置
 *   模型选择：--model
 *   权限模式：不传 --permission-mode，由 CLI 读取本机 settings.json 的
 *            permissions.defaultMode —— 与 Agent 平台、终端 claude 完全一致
 *
 * 两个开关的取舍（都只影响本包，宿主不知情）：
 *   --verbose              -p 模式下输出 stream-json 需要它，否则 claude 直接拒绝
 *   --include-partial-messages  提供 content_block_delta 增量，界面才有打字机效果；
 *                          最终内容仍由 assistant 权威消息收敛（见 parse.ts）
 *
 * 会话 id（uuid）直接可复用，历史回放靠读 CLI 侧 JSONL 文件（见 sessions.ts）
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AgentProvider, RunOptions, RunSession } from "../types";
import type { SessionOptions } from "../../../shared/types";
import { startLineRun } from "../line-run";
import { probeVersion } from "../probe";
import { manifest } from "./manifest";
import { createDecoder, extractSessionId } from "./parse";
import { prepareClaudeWorkflowRun } from "./prepare";
import {
  deleteSession as deleteSessionFile,
  fileVersion,
  readHistory as readHistoryFile,
} from "./sessions";

const BIN = "claude";

/**
 * 宿主内部注入的运行参数 key → 命令行开关。
 *
 * systemPrompt / mcpConfig / strictMcpConfig 由工作流运行按需注入，
 * 不是用户可配置项；普通聊天不会传。
 */
const OPTION_FLAGS: Record<string, string> = {
  systemPrompt: "--append-system-prompt",
  mcpConfig: "--mcp-config",
};

/** 把宿主内部注入的参数翻译成命令行开关；未声明的 key 一律忽略 */
function optionArgs(opts?: SessionOptions): string[] {
  const args: string[] = [];
  for (const [key, flag] of Object.entries(OPTION_FLAGS)) {
    const value = opts?.[key];
    if (value) args.push(flag, value);
  }
  // 只使用显式传入的 MCP，屏蔽全局 / 项目配置（工作流隔离用）
  if (opts?.strictMcpConfig === "1") args.push("--strict-mcp-config");
  return args;
}

export const provider: AgentProvider = {
  manifest,

  detect: () => probeVersion(BIN),

  configInfo() {
    const configPath =
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    return {
      configPath,
      configExists: existsSync(configPath),
      configNote: "直接使用本机 Claude Code 配置（登录、MCP、Skill、插件等）",
    };
  },

  prepareRun(input) {
    return prepareClaudeWorkflowRun(input);
  },

  start(opts: RunOptions): RunSession {
    const args = [
      BIN,
      "-p",
      opts.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    if (opts.sessionRef) args.push("--resume", opts.sessionRef);
    args.push(...optionArgs(opts.opts));
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    return startLineRun(
      {
        args,
        cwd: opts.cwd,
        // 用 PTY：管道传输在 Windows 上走 shell:true，参数只做字符串拼接，
        // 含空格的 prompt 会被拆成多个参数；PTY 由 transport 逐个参数处理引号
        transport: "pty",
        timeoutMs: opts.timeoutMs,
        env: opts.env,
        envRemove: opts.envRemove,
        extractSessionId,
        // 每次运行新建解码器：它记住本次运行内 tool_use id → 工具名，
        // 让随后到达的 tool_result 能补上工具名
        decode: createDecoder(),
      },
      opts,
    );
  },

  /** claude --resume 收的就是会话 id，无需规范化 */
  normalizeSessionRef(rawId) {
    return rawId;
  },

  /** 会话文件是文件，用 mtime 作为版本号，命中率极高 */
  historyVersion(ref, ctx) {
    return fileVersion(ref, ctx.cwd, ctx.configDir);
  },

  readHistory(ref, ctx) {
    return readHistoryFile(ref, ctx.cwd, ctx.configDir);
  },

  deleteSession(ref, ctx) {
    deleteSessionFile(ref, ctx.cwd, ctx.configDir);
  },
};
