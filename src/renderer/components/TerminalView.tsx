/**
 * 系统终端标签
 *
 * xterm.js 负责终端渲染与键盘输入；真实 shell 运行在主进程 node-pty 中。
 * 终端固定纯黑，不随皮肤明暗切换 —— 它是界面里唯一的高对比工作台，
 * 与白色工区形成清晰边界。
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  SquareTerminal,
} from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { useTerminalStore, type TerminalSession } from "../stores/terminal";
import { ipc } from "../lib/ipc";
import { newId } from "../lib/utils";
import { useSkin, useThemeStore } from "../hooks/useTheme";
import { Button } from "./ui/Button";
import { PageHeader } from "./ui/Page";

/**
 * 终端默认使用操作系统自带的等宽字体。
 *
 * 不再跟随皮肤里的 --c-font-mono：那是给代码块用的开发字体
 * （JetBrains Mono / Cascadia Code…），装了这些字体的机器上终端会
 * 变成非系统字体，且各平台观感不一致。
 */
const SYSTEM_MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** 字号限制在可读范围，避免用户输入 0 或过大值 */
function clampTerminalFontSize(size: number): number {
  const px = Math.round(size);
  if (!Number.isFinite(px) || px <= 0) return 15;
  return Math.min(40, Math.max(8, px));
}

export function TerminalView({
  tab,
  showWorkspace,
  onToggleWorkspace,
}: {
  tab: TerminalSession;
  /**
   * 右侧工作区文件面板是否展开。与对话页一致，由终端顶栏按钮切换；
   * 不传 onToggleWorkspace 时不渲染切换按钮。
   */
  showWorkspace?: boolean;
  onToggleWorkspace?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  /** 供字体设置变化时重新适配尺寸 */
  const fitRef = useRef<(() => void) | null>(null);
  const [runtime, setRuntime] = useState<{
    id: string;
    shell: string;
    cwd: string;
  } | null>(null);
  const skin = useSkin();
  const terminalFontSize = useThemeStore((s) => s.terminalFontSize);
  /** PTY 退出后置为退出码，用于在顶栏给出「重新启动」入口 */
  const [exited, setExited] = useState<number | null>(null);
  const restart = useTerminalStore((s) => s.restart);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setExited(null);
    setRuntime(null);
    const processId = `${tab.id}:${tab.generation}:${newId()}`;
    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      // 字号只在创建时取一次；后续修改由下面的 effect 更新 options，
      // 不重建组件（否则会重启 PTY、丢掉正在运行的 claude 会话）。
      fontFamily: SYSTEM_MONO_FONT,
      fontSize: clampTerminalFontSize(terminalFontSize),
      lineHeight: 1.25,
      scrollback: 10000,
      // FitAddon 会从可用宽度里扣掉 overviewRuler.width（未设置时默认 14px），
      // 目的是给右侧滚动条 / 概览标尺留位。终端不需要它，压到 1px，
      // 字符区才能铺满容器宽度，不会只剩右边一条空白。
      overviewRuler: { width: 1 },
      theme: terminalTheme(),
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
      setExited(payload.exitCode);
      term.writeln(
        `\r\n\x1b[90m[process exited with code ${payload.exitCode}]\x1b[0m`,
      );
    });
    const inputSub = term.onData((data) => {
      void ipc.writeTerminal(processId, data);
    });

    /**
     * 剪贴板快捷键。
     *
     * xterm 默认把 Ctrl+V 当成控制字符 0x16 发给 PTY（终端里的 ^V），
     * 并不会粘贴，所以这里显式处理：
     * - Ctrl/Cmd+V、Ctrl+Shift+V、Shift+Insert → 粘贴文本
     * - Ctrl+Shift+C、Ctrl+Insert、Cmd+C → 复制选中内容
     *
     * 剪贴板里没有文本时（例如复制的是图片，Claude Code 用 Ctrl+V 贴图），
     * 原样把 0x16 转发给终端程序，保留它的图片粘贴能力。
     */
    const pasteFromClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          term.paste(text);
          return;
        }
      } catch {
        // 读不到剪贴板时退回到「把按键交给终端程序」
      }
      void ipc.writeTerminal(processId, "\x16");
    };

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const pasteCombo =
        (event.ctrlKey && !event.altKey && !event.metaKey && key === "v") ||
        (event.ctrlKey && event.shiftKey && !event.altKey && key === "v") ||
        (event.metaKey && !event.altKey && key === "v") ||
        (event.shiftKey && !event.ctrlKey && !event.metaKey && event.key === "Insert");
      if (pasteCombo) {
        event.preventDefault();
        void pasteFromClipboard();
        return false;
      }

      const copyCombo =
        (event.ctrlKey && event.shiftKey && !event.altKey && key === "c") ||
        (event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "Insert") ||
        (event.metaKey && !event.altKey && key === "c");
      if (copyCombo) {
        const selection = term.getSelection();
        if (selection) {
          event.preventDefault();
          void navigator.clipboard.writeText(selection);
          return false;
        }
      }

      return true;
    });

    const fitTerminal = () => {
      if (disposed) return;
      // 终端页在非激活侧栏下是 display:none：此时容器没有尺寸，
      // 不要按 0 列去 resize PTY，等重新显示后再适配。
      if (!container.clientWidth || !container.clientHeight) return;
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
    fitRef.current = fitTerminal;

    void ipc
      .createTerminal(processId, tab.cwd, term.cols, term.rows)
      .then((result) => {
        if (disposed) {
          void ipc.killTerminal(processId);
          return;
        }
        setRuntime(result);
        // createTerminal 是异步的：第一帧的 fit 可能先于 PTY 创建发出，
        // 主进程会因找不到会话而忽略。这里在创建完成后再同步一次尺寸。
        requestAnimationFrame(fitTerminal);
        term.focus();
      })
      .catch((error) => {
        if (disposed) return;
        setExited(-1);
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
      fitRef.current = null;
      void ipc.killTerminal(processId);
    };
    // 字体不放进依赖：改字体不应销毁并重建 PTY。
    // generation 变化表示用户点了「重新启动」，需要重开一个 PTY。
  }, [tab.cwd, tab.id, tab.generation]);

  // 字号修改：更新 xterm 选项后重新量字并适配行列
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.fontSize = clampTerminalFontSize(terminalFontSize);
    requestAnimationFrame(() => fitRef.current?.());
  }, [terminalFontSize]);

  useEffect(() => {
    const term = terminalRef.current;
    if (term) term.options.theme = terminalTheme();
    // 把终端背景色写到容器变量上：.xterm-viewport 残留 xterm.css 的 #000 背景，
    // 需要用同一变量覆盖，否则字符区四周留白会被涂成黑/灰边。
    containerRef.current?.style.setProperty(
      "--c-terminal-bg",
      terminalBackground(),
    );
  }, [skin.id]);

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* 与其他中心区域标题栏保持同一高度（--c-layout-header） */}
      <PageHeader
        icon={<SquareTerminal className="h-4 w-4" />}
        title={tab.name}
        subtitle={`${runtime?.shell ?? "shell"} · ${runtime?.cwd ?? tab.cwd}`}
        actions={
          exited !== null ? (
            <>
              <span className="text-meta text-text-muted">
                {exited === -1 ? "启动失败" : `终端已退出（${exited}）`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                icon={<RotateCcw className="h-3.5 w-3.5" />}
                onClick={() => restart(tab.id)}
              >
                重新启动
              </Button>
            </>
          ) : onToggleWorkspace ? (
            <WorkspaceToggleButton
              showWorkspace={Boolean(showWorkspace)}
              onToggle={onToggleWorkspace}
            />
          ) : undefined
        }
      />
      {/* 内边距由 .ui-terminal .xterm 提供：FitAddon 会从可用尺寸里扣除
          .xterm 自身的 padding，放在容器上则不会被扣，终端会被裁掉。 */}
      <div ref={containerRef} className="ui-terminal min-h-0 flex-1 overflow-hidden" />
    </main>
  );
}

/** 顶栏右侧的工作区文件面板开关：与对话页 ChatArea 顶栏同一套交互 */
export function WorkspaceToggleButton({
  showWorkspace,
  onToggle,
}: {
  showWorkspace: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={showWorkspace ? "隐藏工作区文件" : "显示工作区文件"}
      aria-label={showWorkspace ? "隐藏工作区文件" : "显示工作区文件"}
      aria-pressed={showWorkspace}
      className={`ui-btn-round ui-icon-action flex size-icon-btn shrink-0 items-center justify-center rounded-full ${
        showWorkspace ? "text-accent" : ""
      }`}
    >
      {showWorkspace ? (
        <PanelRightClose className="h-4 w-4" />
      ) : (
        <PanelRightOpen className="h-4 w-4" />
      )}
    </button>
  );
}

function terminalBackground(): string {
  // 终端固定纯黑（与夜间皮肤一致），屏幕上的高对比工作台：
  // 不跟随皮肤的明暗，白色皮肤下也保持纯黑，避免浅色终端里
  // 的大片空白与亮色 ANSI 文字互相干扰。
  return "#000000";
}

function terminalTheme() {
  const background = terminalBackground();
  // 前景固定在纯黑上的可读亮灰，不读 --c-text（白天皮肤是深灰文字，黑底上看不清）。
  const foreground = "#e6edf3";
  const accent = readCssValue("--c-accent", "#2f81f7");
  const selection = "rgba(56, 139, 253, 0.25)";

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

  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: selection,
    ...dark,
  };
}

function readCssValue(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

