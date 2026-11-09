/**
 * Claude Code provider
 *
 * Claude Code 是 Anthropic 的终端 AI 编码智能体。
 * 支持 stream-json 流式事件输出与 --resume 会话恢复。
 *
 * CLI 用法（claude 2.1.316，基于 --help 与实跑输出确认）：
 *   首次调用：claude -p --output-format stream-json --verbose --include-partial-messages
 *   恢复会话：claude -p --resume <session_id> --output-format stream-json --verbose ...
 *   prompt 通过 stdin 传入（含换行，不能作为命令行参数）；
 *   系统提示词写入临时文件后用 --append-system-prompt-file 传入。
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

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { AgentProvider, RunOptions, RunSession } from "../types";
import { startLineRun } from "../line-run";
import { probeVersion } from "../probe";
import { manifest } from "./manifest";
import { createDecoder, createStreamDecoder, extractSessionId } from "./parse";
import { createLineStartsResolver } from "./file-lines";
import { prepareClaudeWorkflowRun } from "./prepare";
import { getClaudeSettingsView } from "./settings";
import type { AgentModelEntry } from "../../../shared/contracts/agent";
import {
  deleteSession as deleteSessionFile,
  fileVersion,
  readHistory as readHistoryFile,
} from "./sessions";

const BIN = "claude";

/**
 * 系统提示词落成临时文件。
 *
 * Windows 下经 cmd.exe 启动时，命令行参数中的换行会把整条命令截断，
 * 多行提示词因此不能作为参数传递。返回文件路径与清理函数。
 */
function writeSystemPromptFile(prompt: string): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "novastudio-system-"));
  const path = join(dir, "system.md");
  writeFileSync(path, prompt, "utf8");
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响运行结果
      }
    },
  };
}

/** 模型配置 → 展示用 ID：`deepseek-flash` + `1M` → `deepseek-flash[1M]` */
function formatModelEntry(entry: AgentModelEntry): string {
  const name = entry.name.trim();
  if (!name) return "";
  const context = entry.context.trim();
  return context ? `${name}[${context}]` : name;
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

  /** 运行产物用的本机配置快照：只包含可展示值，API Key 已脱敏 */
  describeRuntimeConfig() {
    try {
      const view = getClaudeSettingsView();
      const config: Record<string, string> = {
        "配置文件": view.settingsPath,
        "默认模型": formatModelEntry(view.defaultModel) || "（未设置，使用 CLI 默认）",
        "权限模式": view.permissionMode,
        "Base URL": view.baseUrl || "（官方默认）",
        "API Key": view.hasApiKey ? view.apiKeyHint : "未配置",
      };
      for (const [alias, entry] of Object.entries(view.modelAliases)) {
        const formatted = formatModelEntry(entry);
        if (formatted) config[`模型别名 ${alias}`] = formatted;
      }

      /*
       * 宿主进程里的 ANTHROPIC_* / CLAUDE_* / MCP_* 会继承给 CLI，
       * 经常是“配置没错但行为不对”的真正原因。这里一并记录，敏感值脱敏。
       */
      const secret = /(token|secret|password|passwd|auth|api[-_]?key|access[-_]?key|credential)/i;
      for (const [key, value] of Object.entries(process.env)) {
        if (!value || !/^(ANTHROPIC|CLAUDE|MCP)_/i.test(key)) continue;
        config[`宿主环境 ${key}`] = secret.test(key)
          ? `（已隐藏，长度 ${value.length}）`
          : value;
      }
      return config;
    } catch (err) {
      return {
        "配置读取失败": err instanceof Error ? err.message : String(err),
      };
    }
  },

  prepareRun(input) {
    return prepareClaudeWorkflowRun(input);
  },

  start(opts: RunOptions): RunSession {
    // prompt 不放进命令行：Windows 上含换行的参数会被 cmd.exe 截断，
    // 后半段开关（--output-format / --mcp-config 等）会整个丢失。
    const args = [
      BIN,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    if (opts.sessionRef) args.push("--resume", opts.sessionRef);

    // 系统提示词同样是多行文本，写入临时文件后用 --append-system-prompt-file
    const systemPrompt = opts.opts?.systemPrompt;
    const systemPromptFile = systemPrompt
      ? writeSystemPromptFile(systemPrompt)
      : null;
    if (systemPromptFile) {
      args.push("--append-system-prompt-file", systemPromptFile.path);
    }

    // 工作流隔离参数（--mcp-config 等）由 prepareRun 通过 extraArgs 注入
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    // 启动前把精确的调用信息交给宿主，写入运行产物
    opts.onInvocation?.({
      command: BIN,
      args: [...args],
      cwd: opts.cwd,
      stdin: "任务输入（prompt 通过 stdin 传入，内容见「任务输入」章节）",
      env: opts.env,
      envRemove: opts.envRemove,
      notes: [
        "prompt 通过 stdin 传入，不在命令行参数中（避免 Windows cmd.exe 截断换行）",
        systemPromptFile
          ? "系统提示词写入临时文件后通过 --append-system-prompt-file 传入"
          : "",
        "未传 --model / --permission-mode：模型与权限由本机 Claude settings.json 决定",
      ].filter(Boolean) as string[],
    });

    const session = startLineRun(
      {
        args,
        cwd: opts.cwd,
        // prompt 通过 stdin 传入，参数里只剩单行开关与路径，
        // Windows 下由 transport 显式经 cmd.exe 解析 .cmd 入口。
        // stream-json 本身逐行输出，不需要 TTY 也能实时流式。
        stdin: opts.prompt,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
        envRemove: opts.envRemove,
        extractSessionId,
        // 每次运行新建解码器：它记住本次运行内 tool_use id → 工具名，
        // 让随后到达的 tool_result 能补上工具名。
        // 所有工具（含 Bash 等命令类）都进入事件流，聊天、任务中心与
        // 工作流运行记录看到的是同一条完整执行链路。
        // 行号定位需要 cwd：Edit / MultiEdit 的 old_string 要在磁盘上的
        // 改动前文件里找位置，供聊天里的 diff 展示真实行号
        decodeLine: createStreamDecoder({
          resolveLineStarts: createLineStartsResolver(opts.cwd),
        }),
        // 兜底通道：decodeLine 已接管实际解析并同时产出事件，decode 不参与
        decode: createDecoder({
          resolveLineStarts: createLineStartsResolver(opts.cwd),
        }),
      },
      opts,
    );

    if (systemPromptFile) {
      void session.done.finally(systemPromptFile.cleanup);
    }

    return session;
  },

  /** claude --resume 收的就是会话 id，无需规范化 */
  normalizeSessionRef(rawId) {
    return rawId;
  },

  /** 会话文件是文件，用 mtime 作为版本号，命中率极高 */
  async historyVersion(ref, ctx) {
    return fileVersion(ref, ctx.cwd, ctx.configDir);
  },

  async readHistory(ref, ctx) {
    return readHistoryFile(ref, ctx.cwd, ctx.configDir);
  },

  async deleteSession(ref, ctx) {
    await deleteSessionFile(ref, ctx.cwd, ctx.configDir);
  },
};
