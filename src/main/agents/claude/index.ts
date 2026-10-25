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
 *   权限模式：--permission-mode <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>
 *            未显式指定时默认 bypassPermissions（最高权限）——宿主尚无授权弹窗，
 *            否则需要授权的工具会被静默拒绝（见 optionArgs）
 *
 * 两个开关的取舍（都只影响本包，宿主不知情）：
 *   --verbose              -p 模式下输出 stream-json 需要它，否则 claude 直接拒绝
 *   --include-partial-messages  提供 content_block_delta 增量，界面才有打字机效果；
 *                          最终内容仍由 assistant 权威消息收敛（见 parse.ts）
 *
 * 与 Pi / OpenCode 的差异：
 *   会话 id（uuid）直接可复用，历史回放靠读 CLI 侧 JSONL 文件（见 sessions.ts）
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
 * 运行参数 key → 命令行开关。permissionMode 见下方 optionArgs（它有默认值）。
 *
 * systemPrompt / mcpConfig / strictMcpConfig 是工作流运行注入的扩展参数：
 * 普通聊天不会传，因此对既有行为零影响。
 */
const OPTION_FLAGS: Record<string, string> = {
  systemPrompt: "--append-system-prompt",
  mcpConfig: "--mcp-config",
};

/**
 * 未显式选择权限模式时使用的档位：最高权限。
 *
 * 宿主目前没有实现授权弹窗（无人应答 canUseTool），若沿用 CLI 默认档位，
 * 任何需要授权的工具都会被直接拒绝，用户只会看到"工具没执行"而不知原因。
 * 因此默认放到最高权限；用户显式选了别的档位则以用户为准。
 */
const DEFAULT_PERMISSION_MODE = "bypassPermissions";

/** 把宿主回传的参数对象翻译成命令行开关；未声明的 key 一律忽略 */
function optionArgs(opts?: SessionOptions): string[] {
  const args: string[] = [];
  for (const [key, flag] of Object.entries(OPTION_FLAGS)) {
    const value = opts?.[key];
    if (value) args.push(flag, value);
  }
  // 权限模式总有值：用户选了用用户的，没选则取最高权限
  args.push("--permission-mode", opts?.permissionMode || DEFAULT_PERMISSION_MODE);
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
