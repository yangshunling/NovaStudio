/**
 * 交互式系统终端管理。
 *
 * 每个标签对应一个 node-pty 进程；数据通过 terminal:data 推送给渲染进程，
 * 渲染进程的输入通过 terminal:write 写回 PTY。
 */

import { existsSync, statSync } from "node:fs";
import * as pty from "node-pty";
import type { TerminalCreateResult } from "../../shared/types";
import { push } from "../ipc/push";

interface ManagedTerminal {
  pty: pty.IPty;
  cwd: string;
  shell: string;
}

const terminals = new Map<string, ManagedTerminal>();

export function createTerminal(
  id: string,
  cwd?: string,
  cols = 80,
  rows = 24,
): TerminalCreateResult {
  if (terminals.has(id)) {
    return {
      id,
      cwd: terminals.get(id)!.cwd,
      shell: terminals.get(id)!.shell,
    };
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
    push("terminal:data", { id, data });
  });
  proc.onExit(({ exitCode, signal }) => {
    terminals.delete(id);
    push("terminal:exit", { id, exitCode, signal });
  });

  return { id, cwd, shell: shell.file };
}

export function writeTerminal(id: string, data: string): boolean {
  const terminal = terminals.get(id);
  if (!terminal) return false;
  terminal.pty.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const terminal = terminals.get(id);
  if (!terminal) return false;
  terminal.pty.resize(clampDimension(cols, 80), clampDimension(rows, 24));
  return true;
}

export function killTerminal(id: string): boolean {
  const terminal = terminals.get(id);
  if (!terminal) return false;
  terminals.delete(id);
  try {
    terminal.pty.kill();
  } catch {
    // 进程可能已退出
  }
  return true;
}

export function stopTerminals(): void {
  for (const id of [...terminals.keys()]) killTerminal(id);
}

function resolveShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoLogo"] };
  }
  return { file: process.env.SHELL || "/bin/bash", args: [] };
}

function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(2, Math.min(1000, Math.floor(value)));
}
