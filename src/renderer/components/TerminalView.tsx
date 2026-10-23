/**
 * 系统终端标签
 *
 * xterm.js 负责终端渲染与键盘输入；真实 shell 运行在主进程 node-pty 中。
 * 颜色通过 Nova 的语义 token 读取，昼夜皮肤会自动适配。
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SquareTerminal } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { TerminalTab } from "../stores/fileViewer";
import { ipc } from "../lib/ipc";
import { newId } from "../lib/utils";
import { useSkin } from "../hooks/useTheme";

export function TerminalView({ tab }: { tab: TerminalTab }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [runtime, setRuntime] = useState<{
    id: string;
    shell: string;
    cwd: string;
  } | null>(null);
  const skin = useSkin();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const processId = `${tab.id}:${newId()}`;
    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: readCssValue("--c-font-mono", "Consolas, monospace"),
      fontSize: readFontSize(),
      lineHeight: 1.25,
      scrollback: 10000,
      theme: terminalTheme(skin.appearance),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    terminalRef.current = term;

    let disposed = false;
    const dataSub = ipc.on.terminalData((payload) => {
      if (payload.id === processId) term.write(payload.data);
    });
    const exitSub = ipc.on.terminalExit((payload) => {
      if (payload.id !== processId) return;
      term.writeln(
        `\r\n\x1b[90m[process exited with code ${payload.exitCode}]\x1b[0m`,
      );
    });
    const inputSub = term.onData((data) => {
      void ipc.writeTerminal(processId, data);
    });

    const fitTerminal = () => {
      if (disposed) return;
      try {
        fit.fit();
        void ipc.resizeTerminal(processId, term.cols, term.rows);
      } catch {
        // 容器在切换标签时可能暂时无尺寸。
      }
    };
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(fitTerminal);
    });
    observer.observe(container);
    requestAnimationFrame(fitTerminal);

    void ipc
      .createTerminal(processId, tab.cwd, term.cols, term.rows)
      .then((result) => {
        if (disposed) {
          void ipc.killTerminal(processId);
          return;
        }
        setRuntime(result);
        term.focus();
      })
      .catch((error) => {
        if (disposed) return;
        term.writeln(
          `\x1b[31mFailed to start terminal: ${String(error)}\x1b[0m`,
        );
      });

    return () => {
      disposed = true;
      observer.disconnect();
      dataSub();
      exitSub();
      inputSub.dispose();
      term.dispose();
      terminalRef.current = null;
      void ipc.killTerminal(processId);
    };
  }, [tab.cwd, tab.id]);

  useEffect(() => {
    const term = terminalRef.current;
    if (term) term.options.theme = terminalTheme(skin.appearance);
  }, [skin.appearance, skin.id]);

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* 与其他中心区域标题栏保持同一高度（--c-layout-header） */}
      <div className="ui-glass flex h-[var(--c-layout-header)] shrink-0 items-center gap-2 border-b border-border px-4 text-meta text-text-muted">
        <SquareTerminal className="h-4 w-4 shrink-0 text-accent" />
        <span className="shrink-0 font-mono font-medium text-text-secondary">
          {runtime?.shell ?? "shell"}
        </span>
        <span className="min-w-0 truncate font-mono" title={runtime?.cwd}>
          {runtime?.cwd ?? tab.cwd}
        </span>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden bg-bg" />
    </main>
  );
}

function terminalTheme(appearance: "light" | "dark") {
  const background = readCssValue("--c-bg", "#0d1117");
  const foreground = readCssValue("--c-text", "#e6edf3");
  const accent = readCssValue("--c-accent", "#2f81f7");
  const selection = readCssValue("--c-accent-soft", "rgba(47,129,247,.25)");

  const dark = {
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  };
  const light = {
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#7d4e00",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#24292f",
  };

  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: selection,
    ...(appearance === "dark" ? dark : light),
  };
}

function readCssValue(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function readFontSize(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--c-font-size")
    .trim();
  const size = Number.parseFloat(raw);
  return Number.isFinite(size) ? Math.max(11, size) : 13;
}
