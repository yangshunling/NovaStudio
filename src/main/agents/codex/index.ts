/**
 * Codex provider
 *
 * Codex 是 OpenAI 的终端 AI 编码智能体（https://developers.openai.com/codex）。
 * 支持 --json 的行分隔事件流与 `exec resume` 会话恢复。
 *
 * CLI 用法（codex-cli 0.154.0，基于 --help 与实跑输出确认）：
 *   首次调用：codex exec "<prompt>" --json --skip-git-repo-check
 *   恢复会话：codex exec resume <thread_id> "<prompt>" --json --skip-git-repo-check
 *   检测安装：codex --version
 *   工作目录：codex exec 有 -C/--cd，但进程的 cwd 已经生效（实测），故不再重复传
 *   模型选择：-m/--model
 *   沙箱策略：-s/--sandbox <read-only|workspace-write|danger-full-access>
 *            未显式指定时用 --dangerously-bypass-approvals-and-sandbox（最高权限）
 *            ——codex exec 是非交互的，弹不出新审批，默认沙箱会让越界命令直接失败
 *
 * --skip-git-repo-check 的取舍：宿主里的「项目」是用户任意选的文件夹，不一定是
 * git 仓库，不加这个开关 Codex 会直接拒绝运行。
 *
 * 与其它 provider 的差异：
 *   1. 会话 id = thread_id，直接可复用（无需升级为文件路径）
 *   2. 历史回放靠读 CLI 侧的 rollout JSONL（见 sessions.ts）
 *   3. 会话删除靠 `codex delete` 命令，而非删文件
 */

import type { AgentProvider, RunOptions, RunSession } from "../types";
import type { SessionOptions } from "../../../shared/types";
import { startLineRun } from "../line-run";
import { probeVersion } from "../probe";
import { manifest } from "./manifest";
import { createDecoder, extractSessionId } from "./parse";
import { listModels as listAvailableModels } from "./models";
import {
  deleteSession as deleteSessionRemote,
  fileVersion,
  readHistory as readHistoryRemote,
} from "./sessions";

const BIN = "codex";

/** 运行参数 key → 命令行开关。sandbox 见下方 optionArgs（它有默认行为） */
const OPTION_FLAGS: Record<string, string> = {
  model: "--model",
};

/**
 * 未显式选择沙箱策略时使用的开关：跳过全部确认且不使用沙箱（最高权限）。
 *
 * 宿主目前没有实现授权应答，codex exec 又是非交互的（无法弹出新审批），
 * 沿用默认的 read-only 沙箱会让越界命令直接失败。因此默认完全放开；
 * 用户在「运行参数」里显式选了沙箱策略，则以用户的选择为准。
 *
 * 官方文档里 `--yolo` 是它的等价短别名（0.154.0 实测可解析，但 --help 未列出），
 * 这里用 --help 与文档都收录的长名。
 */
const YOLO_FLAG = "--dangerously-bypass-approvals-and-sandbox";

/** 把宿主回传的参数对象翻译成命令行开关；未声明的 key 一律忽略 */
function optionArgs(opts?: SessionOptions): string[] {
  const args: string[] = [];
  for (const [key, flag] of Object.entries(OPTION_FLAGS)) {
    const value = opts?.[key];
    if (value) args.push(flag, value);
  }
  // 沙箱策略与 YOLO 互斥：用户选了策略就按策略走，否则完全放开
  if (opts?.sandbox) args.push("--sandbox", opts.sandbox);
  else args.push(YOLO_FLAG);
  return args;
}

export const provider: AgentProvider = {
  manifest,

  detect: () => probeVersion(BIN),

  listModels: listAvailableModels,

  start(opts: RunOptions): RunSession {
    // 恢复会话是独立子命令：codex exec resume <thread_id> "<prompt>"
    const args = opts.sessionRef
      ? [BIN, "exec", "resume", opts.sessionRef, opts.prompt]
      : [BIN, "exec", opts.prompt];
    args.push("--json", "--skip-git-repo-check");
    args.push(...optionArgs(opts.opts));

    return startLineRun(
      {
        args,
        cwd: opts.cwd,
        // 用 PTY：管道传输在 Windows 上走 shell:true，参数只做字符串拼接，
        // 含空格的 prompt 会被拆成多个参数；PTY 由 transport 逐个参数处理引号
        transport: "pty",
        timeoutMs: opts.timeoutMs,
        extractSessionId,
        // 每次运行新建解码器：它记住本次运行内已上报的条目 id，
        // 使同一条目的「进行中 → 完成」收敛到一条，而不是两条
        decode: createDecoder(),
      },
      opts,
    );
  },

  /** Codex 的 thread_id 直接可长期复用，无需规范化 */
  normalizeSessionRef(rawId) {
    return rawId;
  },

  /** rollout 是文件，用 mtime 作为版本号 */
  historyVersion(ref) {
    return fileVersion(ref);
  },

  readHistory(ref) {
    return readHistoryRemote(ref);
  },

  deleteSession(ref) {
    deleteSessionRemote(ref);
  },
};
