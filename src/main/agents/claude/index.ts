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
 *   权限模式：--permission-mode（会话级快照，settings 名 default 映射为 CLI 名 manual）；
 *            无法识别时退回 CLI 读取本机 settings.json 的 permissions.defaultMode
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
import type {
  AgentProvider,
  CompleteOptions,
  RunOptions,
  RunSession,
} from "../types";
import { startLineRun } from "../line-run";
import { spawnChild, type Transport } from "../transport";
import { probeVersion } from "../probe";
import { manifest } from "./manifest";
import { createDecoder, createStreamDecoder, extractSessionId } from "./parse";
import { buildUserInput, usesStreamJsonInput } from "./input";
import { createLineStartsResolver } from "./file-lines";
import { prepareClaudeChatRun } from "./chat-runtime";
import { prepareClaudeWorkflowRun } from "./prepare";
import { getClaudeSettingsView } from "./settings";
import { encodeControlResponse, toCliPermissionMode } from "./permission";
import {
  DEFAULT_PERMISSION_MODE,
  modeMayAsk,
} from "../../../shared/permission";
import { formatModelEntry } from "./models";
import { checkClaudeUpgrade, upgradeClaude } from "./upgrade";
import {
  deleteSession as deleteSessionFile,
  fileVersion,
  readHistory as readHistoryFile,
} from "./sessions";
import { errorMessage } from "../../../shared/error";

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

/** 一次性文本生成的默认超时：提交信息等小任务不应无限等待 */
const COMPLETE_TIMEOUT_MS = 120_000;
/** 一次性生成只保留诊断尾部，避免异常输出占满内存 */
const COMPLETE_STDERR_LIMIT = 4000;

/**
 * 一次性文本生成。
 *
 * 与 start() 的差别：
 * - --output-format text：只要最终文本，不解析事件流
 * - --tools ""：禁用全部内置工具，模型不能读写仓库
 * - --no-session-persistence：不落盘会话，不污染用户历史
 */
function completeOnce(opts: CompleteOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const limit = opts.timeoutMs ?? COMPLETE_TIMEOUT_MS;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let transport: Transport | null = null;
    let timer: NodeJS.Timeout | null = null;
    let removeAbortListener: (() => void) | null = null;

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeAbortListener?.();
      action();
    };

    timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `生成超时（${Math.round(limit / 1000)} 秒），请稍后重试`,
          ),
        ),
      );
      transport?.kill();
    }, limit);

    transport = spawnChild(
      [
        BIN,
        "-p",
        "--output-format",
        "text",
        // 空字符串表示禁用全部内置工具
        "--tools",
        "",
        "--no-session-persistence",
      ],
      opts.cwd,
      undefined,
      undefined,
      {
        onData: (chunk) => {
          stdout += chunk;
          opts.onChunk?.(chunk);
        },
        onStderr: (chunk) => {
          stderr = (stderr + chunk).slice(-COMPLETE_STDERR_LIMIT);
        },
        onExit: (code) => {
          if (code === 0) {
            settle(() => resolve(stdout.trim()));
          } else {
            settle(() =>
              reject(
                new Error(stderr.trim() || `Claude 进程退出码 ${code}`),
              ),
            );
          }
        },
      },
    );

    /*
     * 取消信号在 spawn 之后注册：这样 abort 时一定已经拿到真实进程，
     * 不会出现「已 reject 但子进程仍在跑」的泄漏。
     */
    const signal = opts.signal;
    if (signal) {
      if (signal.aborted) {
        settle(() => reject(new Error("已取消")));
        transport.kill();
        return;
      }
      const onAbort = () => {
        settle(() => reject(new Error("已取消")));
        transport?.kill();
      };
      signal.addEventListener("abort", onAbort);
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }

    transport.writeInput(opts.prompt);
  });
}

export const provider: AgentProvider = {
  manifest,

  detect: () => probeVersion(BIN),

  checkUpgrade: () => checkClaudeUpgrade(),

  upgrade: (onProgress) => upgradeClaude(onProgress),

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
        "配置读取失败": errorMessage(err),
      };
    }
  },

  /** 新会话 / 无工具栏运行的默认权限：读 settings.json，未配置时用 Nova 默认 */
  defaultPermissionMode() {
    try {
      return getClaudeSettingsView().permissionMode;
    } catch {
      return DEFAULT_PERMISSION_MODE;
    }
  },

  prepareRun(input) {
    return prepareClaudeWorkflowRun(input);
  },

  prepareChatRun(input) {
    return prepareClaudeChatRun(input);
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

    /*
     * 会话级权限：宿主已把「会话快照 / Agent 默认值」解析成 settings 命名，
     * 这里只做 CLI 名字映射。无法识别的值不传，退回 CLI 读取本机配置。
     */
    const cliPermissionMode = toCliPermissionMode(opts.permissionMode);
    if (cliPermissionMode) {
      args.push("--permission-mode", cliPermissionMode);
    }

    /*
     * 会话级模型覆盖：只影响本次进程，不写回 settings.json。
     * 未指定时不传，继续由 CLI 读取本机配置的 ANTHROPIC_MODEL / 别名。
     * 空字符串会被 CLI 当作非法值，因此清洗后再判断。
     */
    const model = opts.model?.trim();
    if (model) {
      args.push("--model", model);
    }

    /*
     * 交互式工具授权：只有带 UI 的聊天运行、且模式可能 ask 时才启用。
     * CLI 会把 can_use_tool 发到 stdout 的控制通道，宿主必须把
     * control_response 写回同一根 stdin，因此还要强制 stream-json 输入
     * 并保持 stdin 打开。
     */
    const interactive =
      opts.allowPermissionPrompts === true && modeMayAsk(opts.permissionMode);
    if (interactive) args.push("--permission-prompt-tool", "stdio");

    /*
     * stream-json 输入的两种触发条件：
     * - 带图片：text 格式只能传纯文本，图片必须是 content block
     * - 交互授权：控制应答要写回 stdin
     * CLI 要求该输入格式与 stream-json 输出搭配（输出格式本来就是）。
     */
    const streamInput = usesStreamJsonInput(opts.images, interactive);
    if (streamInput) args.push("--input-format", "stream-json");

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
      stdin: streamInput
        ? "任务输入（stream-json 用户消息；内容见「任务输入」章节）"
        : "任务输入（prompt 通过 stdin 传入，内容见「任务输入」章节）",
      env: opts.env,
      envRemove: opts.envRemove,
      notes: [
        "prompt 通过 stdin 传入，不在命令行参数中（避免 Windows cmd.exe 截断换行）",
        streamInput
          ? "使用 --input-format stream-json 传入用户消息"
          : "",
        interactive
          ? "本轮启用交互式工具授权：--permission-prompt-tool stdio（控制应答写回 stdin）"
          : "",
        systemPromptFile
          ? "系统提示词写入临时文件后通过 --append-system-prompt-file 传入"
          : "",
        model
          ? `模型来自会话配置：${model}（不写回 settings.json）`
          : "未传 --model：模型由本机 Claude settings.json 决定",
        cliPermissionMode
          ? `权限模式来自会话级配置：${cliPermissionMode}`
          : "未传 --permission-mode：权限由本机 Claude settings.json 决定",
      ].filter(Boolean) as string[],
    });

    const session = startLineRun(
      {
        args,
        cwd: opts.cwd,
        // prompt 通过 stdin 传入，参数里只剩单行开关与路径，
        // Windows 下由 transport 显式经 cmd.exe 解析 .cmd 入口。
        // stream-json 本身逐行输出，不需要 TTY 也能实时流式。
        stdin: buildUserInput(opts.prompt, opts.images, streamInput),
        // 交互授权时 stdin 要保持打开，回写 control_response；收到 result 再关
        keepStdinOpen: interactive,
        onControlMessage: opts.onControl,
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

    if (!interactive) return session;

    /*
     * 语义层应答：AgentService 只调 respondPermission，不感知
     * control_response 的 wire shape。
     */
    return {
      done: session.done,
      get aborted() {
        return session.aborted;
      },
      abort: () => session.abort(),
      respondPermission(requestId, decision) {
        if (!session.respondControl) return false;
        return session.respondControl(
          encodeControlResponse(requestId, decision),
        );
      },
    };
  },

  /** 一次性文本生成（提交信息等宿主内部任务） */
  complete: completeOnce,

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
