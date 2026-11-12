/**
 * 交互式系统终端管理。
 *
 * 每个标签对应一个 node-pty 进程；数据通过 terminal:data 推送给渲染进程，
 * 渲染进程的输入通过 terminal:write 写回 PTY。
 *
 * 本模块不感知 Electron：事件出口由装配层注入（见 shared/contracts/ipc 的
 * Emit），因此可以脱离窗口单测。所有可变状态收在 createTerminalManager 的
 * 闭包里，生命周期由调用方掌握。
 */

import { existsSync, statSync } from "node:fs";
import * as pty from "node-pty";
import type { TerminalCreateResult } from "../../shared/types";
import type { Emit } from "../../shared/contracts/ipc";
import { clamp } from "../../shared/math";

interface ManagedTerminal {
  pty: pty.IPty;
  cwd: string;
  shell: string;
}

export interface TerminalManager {
  create(id: string, cwd?: string, cols?: number, rows?: number): TerminalCreateResult;
  write(id: string, data: string): boolean;
  resize(id: string, cols: number, rows: number): boolean;
  kill(id: string): boolean;
  /** 回收全部终端（窗口关闭 / 渲染进程崩溃 / 应用退出） */
  stopAll(): void;
}

/** 同时存活的终端上限：防止渲染层异常时无限拉起 shell 进程 */
const MAX_TERMINALS = 12;

/**
 * PTY 输出按 16ms 窗口合并。
 *
 * `npm install`、日志刷屏时每个 chunk 一次 IPC 会造成消息风暴；
 * 按终端 id 拼接后一批只发一条，既保持接近实时的观感，又把 IPC 次数
 * 从「每 chunk」降到「每帧」。
 */
const TERMINAL_FLUSH_MS = 16;

export function createTerminalManager(emit: Emit): TerminalManager {
  const terminals = new Map<string, ManagedTerminal>();
  const pendingData = new Map<string, string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushTerminalData(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingData.size === 0) return;
    const batch = [...pendingData];
    pendingData.clear();
    for (const [id, data] of batch) emit("terminal:data", { id, data });
  }

  function enqueueTerminalData(id: string, data: string): void {
    pendingData.set(id, (pendingData.get(id) ?? "") + data);
    if (!flushTimer) {
      flushTimer = setTimeout(flushTerminalData, TERMINAL_FLUSH_MS);
    }
  }

  function create(
    id: string,
    cwd?: string,
    cols = 80,
    rows = 24,
  ): TerminalCreateResult {
    const existing = terminals.get(id);
    if (existing) {
      return { id, cwd: existing.cwd, shell: existing.shell };
    }

    if (terminals.size >= MAX_TERMINALS) {
      throw new Error(`同时打开的终端已达上限（${MAX_TERMINALS} 个）`);
    }

    // 不再静默回退到用户主目录：目录被移动或删除时必须让用户看到原因，
    // 否则终端会在 ~ 下打开，用户以为终端定位错了工作区。
    if (!cwd) throw new Error("终端工作目录未指定");
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`终端工作目录不存在：${cwd}`);
    }

    const shell = resolveShell();
    const proc = pty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: clampDimension(cols, 80),
      rows: clampDimension(rows, 24),
      cwd,
      env: process.env as Record<string, string>,
    });

    terminals.set(id, { pty: proc, cwd, shell: shell.file });

    proc.onData((data) => {
      enqueueTerminalData(id, data);
    });
    proc.onExit(({ exitCode, signal }) => {
      // 先送达最后一批输出，再通知退出，渲染层不会丢掉尾部日志
      flushTerminalData();
      terminals.delete(id);
      emit("terminal:exit", { id, exitCode, signal });
    });

    return { id, cwd, shell: shell.file };
  }

  function write(id: string, data: string): boolean {
    const terminal = terminals.get(id);
    if (!terminal) return false;
    terminal.pty.write(data);
    return true;
  }

  function resize(id: string, cols: number, rows: number): boolean {
    const terminal = terminals.get(id);
    if (!terminal) return false;
    terminal.pty.resize(clampDimension(cols, 80), clampDimension(rows, 24));
    return true;
  }

  function kill(id: string): boolean {
    const terminal = terminals.get(id);
    if (!terminal) return false;
    flushTerminalData();
    terminals.delete(id);
    try {
      terminal.pty.kill();
    } catch {
      // 进程可能已退出
    }
    return true;
  }

  function stopAll(): void {
    for (const id of [...terminals.keys()]) kill(id);
  }

  return { create, write, resize, kill, stopAll };
}

function resolveShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoLogo"] };
  }
  return { file: process.env.SHELL || "/bin/bash", args: [] };
}

function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(Math.floor(value), 2, 1000);
}
