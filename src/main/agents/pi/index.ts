/**
 * Pi provider
 *
 * Pi 是一个终端 AI 编码智能体，支持 print 模式与 session 恢复。
 * 文档：https://pi.dev/docs/latest
 *
 * CLI 用法（pi 0.85.1，基于 --help 实测）：
 *   首次调用：pi -p "<prompt>" --mode json
 *   恢复会话：pi -p "<prompt>" --session <id|path> --mode json
 *   检测安装：pi --version
 *   工作目录：pi 无 -C 选项，通过进程的 cwd 设置
 *
 * 本文件只负责「拼出 pi 的命令行 + 把协议接到宿主」；
 * 字节级解析与会话文件处理分别在 parse.ts / sessions.ts。
 */

import type { AgentProvider, RunOptions, RunSession } from "../types";
import type { SessionOptions } from "../../../shared/types";
import { startLineRun } from "../line-run";
import { probeVersion } from "../probe";
import { manifest } from "./manifest";
import { decode, extractSessionId } from "./parse";
import { listModels as listAvailableModels } from "./models";
import {
  deleteSession as deleteSessionFile,
  fileVersion,
  locateSessionFile,
  readHistory as readHistoryFile,
} from "./sessions";

const BIN = "pi";

/** 运行参数 key → 命令行开关。与 manifest.options 的 key 一一对应 */
const OPTION_FLAGS: Record<string, string> = {
  model: "--model",
  thinking: "--thinking",
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

  listModels: listAvailableModels,

  start(opts: RunOptions): RunSession {
    const args = [BIN, "-p", opts.prompt, "--mode", "json"];
    if (opts.sessionRef) args.push("--session", opts.sessionRef);
    args.push(...optionArgs(opts.opts));

    return startLineRun(
      {
        args,
        cwd: opts.cwd,
        // 用 PTY：pi 在非 TTY 下会块缓冲，流式输出会卡到进程结束才吐出来
        transport: "pty",
        timeoutMs: opts.timeoutMs,
        extractSessionId,
        decode,
      },
      opts,
    );
  },

  /** uuid → 会话 JSONL 文件绝对路径；定位失败则退回原始 id */
  normalizeSessionRef(rawId, ctx) {
    return locateSessionFile(ctx.cwd, rawId) ?? rawId;
  },

  /** 会话文件是文件，用 mtime 作为版本号，命中率极高 */
  historyVersion(ref) {
    return fileVersion(ref);
  },

  readHistory(ref) {
    return readHistoryFile(ref);
  },

  deleteSession(ref) {
    deleteSessionFile(ref);
  },
};
