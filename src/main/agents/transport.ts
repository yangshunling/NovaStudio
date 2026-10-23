/**
 * 传输层 — provider 与子进程之间的管道
 *
 * 只负责「把命令跑起来、把输出原样吐出来」：
 * 不关心输出格式、不切分行、不解析 JSON、不知道任何具体 Agent 的存在。
 *
 * 切分与解码是 provider 自己的职责（见 line-run.ts 与各 provider 的 decode.ts）。
 * 回调在创建时一次性传入，避免「先 spawn 后注册」导致早期输出丢失。
 */

import * as pty from "node-pty";
import { execFile, execFileSync, spawn } from "child_process";

/** 传输句柄：只暴露终止能力 */
export interface Transport {
  kill(): void;
}

/** 传输回调，创建时注入 */
export interface TransportHandlers {
  onData: (chunk: string) => void;
  onExit: (exitCode: number) => void;
}

/**
 * 过滤终端控制序列，只保留有效文本。
 * PTY 模式下子进程会输出颜色、光标移动、清屏等序列，这些会破坏文本解析。
 */
export function stripAnsi(text: string): string {
  return (
    text
      // CSI：颜色 / 光标 / 清屏  \x1b[...X
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      // OSC：窗口标题 \x1b]...\x07 或 \x1b]...\x1b\\
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // 字符集选择 \x1b(B 等
      .replace(/\x1b[()*+][AB012]/g, "")
      // 其他单字符 ESC 序列
      .replace(/\x1b[=>]/g, "")
      // 控制字符：退格、响铃、垂直制表等
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
      // 回车符（\r\n 中的 \r）
      .replace(/\r/g, "")
  );
}

/** 行缓冲：把任意分片的输出切成完整行，尾部残片留到下次 */
export function createLineBuffer() {
  let buffer = "";
  return {
    /** 追加一段输出，返回本次凑齐的完整行（不含结尾换行） */
    push(chunk: string): string[] {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      return lines;
    },
    /** 取走尾部残片（进程退出时调用） */
    take(): string {
      const rest = buffer;
      buffer = "";
      return rest;
    },
  };
}

/** 需要引号包裹的字符：空白与 shell 元字符（避免参数被 shell 拆开或劫持） */
const NEEDS_QUOTE = /[\s"&|<>^()]/;

/** 拼装命令行：含空白或 shell 元字符的参数加引号，内嵌双引号转义 */
export function toCommandLine(args: string[]): string {
  return args
    .map((a) => (NEEDS_QUOTE.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ");
}

/**
 * 同步执行一条 CLI 命令并返回 stdout。
 *
 * Windows 上 npm 全局入口是 .cmd，必须经 cmd.exe 才能解析，因此这里自建命令行；
 * 其余平台直接以参数数组形式调用，不经过 shell，从根本上避免引号拼接问题。
 */
export function execCliSync(args: string[], timeoutMs: number): string {
  const options = {
    encoding: "utf8" as BufferEncoding,
    timeout: timeoutMs,
    windowsHide: true,
  };
  if (process.platform === "win32") {
    return execFileSync("cmd.exe", ["/d", "/s", "/c", toCommandLine(args)], options);
  }
  return execFileSync(args[0], args.slice(1), options);
}

/**
 * 异步执行一条 CLI 命令并返回 stdout。
 *
 * 与 execCliSync 共用同一套平台适配，区别是不阻塞主进程 ——
 * 用于启动期的安装探测等「不该卡住 UI」的一次性调用。
 */
export function execCli(args: string[], timeoutMs: number): Promise<string> {
  const options = {
    encoding: "utf8" as BufferEncoding,
    timeout: timeoutMs,
    windowsHide: true,
  };
  const [file, argv] =
    process.platform === "win32"
      ? (["cmd.exe", ["/d", "/s", "/c", toCommandLine(args)]] as const)
      : ([args[0], args.slice(1)] as const);

  return new Promise((resolve, reject) => {
    execFile(file, [...argv], options, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * 用伪终端启动。
 * PTY 让子进程认为 stdout 是 TTY，使用行缓冲，输出实时（解决管道块缓冲问题）。
 * Windows 下经 cmd.exe 执行，能正确找到 npm 全局安装的 .cmd 入口；
 * POSIX 下走 /bin/sh -lc，保证 PATH 生效。
 *
 * Windows 上必须把参数**逐个**交给 node-pty，由它自己加引号：
 * 若先拼成一条已加引号的命令行走 toCommandLine，node-pty 会再转义一次内层引号，
 * cmd.exe 拿到的是被转义的引号，含空格的参数会被拆开（实测 prompt 只剩下第一个词）。
 */
export function spawnPty(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> | undefined,
  handlers: TransportHandlers,
): Transport {
  const win = process.platform === "win32";
  // cmd.exe 的 /c 会把其后的整条命令拼起来，因此参数按原样展开即可
  const file = win ? "cmd.exe" : "/bin/sh";
  const argv = win ? ["/d", "/s", "/c", ...args] : ["-lc", toCommandLine(args)];

  const proc = pty.spawn(file, argv, {
    name: "xterm-256color",
    cols: 9999,
    rows: 999,
    cwd,
    env: { ...process.env, ...envOverrides } as Record<string, string>,
  });

  proc.onData((data) => handlers.onData(data));
  proc.onExit(({ exitCode }) => handlers.onExit(exitCode));

  return {
    kill() {
      try {
        proc.kill();
      } catch {
        // 进程可能已退出
      }
    },
  };
}

/**
 * 用普通管道启动（无 TTY）。
 * 适用于不需要终端特性的 CLI；Windows 下开 shell 以便解析 .cmd。
 */
export function spawnChild(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> | undefined,
  handlers: TransportHandlers,
): Transport {
  const child = spawn(args[0], args.slice(1), {
    cwd,
    shell: process.platform === "win32",
    windowsHide: true,
    env: { ...process.env, ...envOverrides },
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => handlers.onData(chunk));
  child.stderr.on("data", (chunk: string) => handlers.onData(chunk));
  child.on("error", (err) => {
    handlers.onData(`${err.message}\n`);
    handlers.onExit(-1);
  });
  child.on("close", (code) => handlers.onExit(code ?? -1));

  return {
    kill() {
      try {
        child.kill();
      } catch {
        // 进程可能已退出
      }
    },
  };
}
