/**
 * OpenCode provider
 *
 * OpenCode 是一个开源的终端 AI 编码智能体（https://opencode.ai）。
 * 支持 --format json 的流式 JSON 事件输出与 --session 会话恢复。
 *
 * CLI 用法（opencode 1.18.31，基于 --help 实测）：
 *   首次调用：opencode run "<prompt>" --format json --thinking --auto
 *   恢复会话：opencode run "<prompt>" --session <id> --format json --thinking --auto
 *   检测安装：opencode --version
 *   工作目录：通过进程的 cwd 设置
 *   模型选择：-m <provider/model>
 *   思考档位：--variant <level>
 *   权限：--auto（自动批准未被显式 deny 的请求；宿主无授权应答，故默认开启）
 *
 * OpenCode 与 Pi 的三点关键差异（都收敛在本包内，宿主不知情）：
 *   1. 会话 id（ses_xxx）直接可用，无需升级为文件路径
 *   2. 历史回放靠 `opencode export` 命令，而非读文件
 *   3. 会话删除靠 `opencode session delete` 命令，而非删文件
 */

import type { AgentProvider, RunOptions, RunSession } from "../types";
import type { SessionOptions } from "../../../shared/types";
import { startLineRun } from "../line-run";
import { probeVersion } from "../probe";
import { manifest } from "./manifest";
import { createDecoder, extractSessionId } from "./parse";
import { deleteSession as deleteSessionRemote, readHistory as readHistoryRemote } from "./sessions";

const BIN = "opencode";

/** 运行参数 key → 命令行开关。与 manifest.options 的 key 一一对应 */
const OPTION_FLAGS: Record<string, string> = {
  model: "-m",
  thinking: "--variant",
};

/** 把宿主回传的参数对象翻译成命令行开关；未声明的 key 一律忽略 */
function optionArgs(opts?: SessionOptions): string[] {
  if (!opts) return [];
  const args: string[] = [];
  for (const [key, flag] of Object.entries(OPTION_FLAGS)) {
    const value = opts[key];
    if (value) args.push(flag, value);
  }
  return args;
}

export const provider: AgentProvider = {
  manifest,

  detect: () => probeVersion(BIN),

  start(opts: RunOptions): RunSession {
    // --auto：自动批准未被显式 deny 的权限请求（CLI 里能达到的最高权限；
    // 宿主没有实现授权应答，不加它需要审批的工具会卡住/被拒）
    const args = [BIN, "run", opts.prompt, "--format", "json", "--thinking", "--auto"];
    if (opts.sessionRef) args.push("--session", opts.sessionRef);
    args.push(...optionArgs(opts.opts));

    return startLineRun(
      {
        args,
        cwd: opts.cwd,
        transport: "pty",
        timeoutMs: opts.timeoutMs,
        extractSessionId,
        // 每次运行新建解码器：它记住本次运行各次工具调用的状态，
        // 使同一次调用的「进行中 → 完成」收敛到同一条，而不是两行
        decode: createDecoder(),
      },
      opts,
    );
  },

  /** OpenCode 的会话 id 直接可长期复用，无需规范化 */
  normalizeSessionRef(rawId) {
    return rawId;
  },

  /**
   * OpenCode 没有廉价的"会话是否变化"判断：export 本身就是重操作，
   * 无法从中得到版本号，因此显式声明不支持缓存。
   * 这是 provider 自己的取舍 —— 宿主不再假设引用一定是文件。
   */
  historyVersion() {
    return null;
  },

  readHistory(ref) {
    return readHistoryRemote(ref);
  },

  deleteSession(ref) {
    deleteSessionRemote(ref);
  },
};
