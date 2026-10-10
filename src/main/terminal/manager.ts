/**
 * 交互式系统终端管理。
 *
 * 每个标签对应一个 node-pty 进程；数据通过 terminal:data 推送给渲染进程，
 * 渲染进程的输入通过 terminal:write 写回 PTY。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
  const resolvedCwd = cwd && existsSync(cwd) ? cwd : homedir();
  const shell = resolveShell();

  if (terminals.has(id)) {
    return {
      id,
      cwd: terminals.get(id)!.cwd,
      shell: terminals.get(id)!.shell,
    };
  }

  const proc = pty.spawn(shell.file, shell.args, {
    name: "xterm-256color",
    cols: clampDimension(cols, 80),
    rows: clampDimension(rows, 24),
    cwd: resolvedCwd,
    env: process.env as Record<string, string>,
  });

  terminals.set(id, { pty: proc, cwd: resolvedCwd, shell: shell.file });

  proc.onData((data) => {
    push("terminal:data", { id, data });
  });
  proc.onExit(({ exitCode, signal }) => {
    terminals.delete(id);
    push("terminal:exit", { id, exitCode, signal });
  });

  return { id, cwd: resolvedCwd, shell: shell.file };
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
