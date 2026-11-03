/**
 * 传输层 — provider 与子进程之间的管道
 *
 * 只负责「把命令跑起来、把输出原样吐出来」：
 * 不关心输出格式、不切分行、不解析 JSON、不知道任何具体 Agent 的存在。
 *
 * 切分与解码是 provider 自己的职责（见 line-run.ts 与各 provider 的 parse.ts）。
 * 回调在创建时一次性传入，避免「先 spawn 后注册」导致早期输出丢失。
 */

import { execFile, spawn } from "child_process";

/** 传输句柄：终止 + 写入 stdin */
export interface Transport {
  kill(): void;
  /**
   * 写入 stdin 并关闭。
   *
   * prompt 必须走 stdin 而不是命令行参数：Windows 下经 cmd.exe 启动时，
   * 参数里的换行会把命令行截断（后半段参数全部丢失），而工作流 prompt
   * 与系统提示词几乎必然包含换行。
   */
  writeInput(data: string): void;
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

/**
 * 合并宿主环境与本次覆盖值，并剔除需要屏蔽的键。
 *
 * `envRemove` 必须最后生效：否则 process.env 里的同名变量会在展开时
 * 重新出现，覆盖节点自己的隔离配置。
 */
function buildEnv(
  overrides: Record<string, string> | undefined,
  remove: string[] | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...overrides,
  };
  for (const key of remove ?? []) delete env[key];
  return env;
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
 * 异步执行一条 CLI 命令并返回 stdout。
 *
 * 用于启动期的安装探测等「不该卡住主进程」的一次性调用。
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
 * 用普通管道启动（无 TTY）。
 * 适用于不需要终端特性的 CLI；stdin 可用于传入含换行的 prompt。
 *
 * Windows 下显式经 cmd.exe 解析 .cmd 入口，并把参数逐个交给 spawn，
 * 由 Node 负责引用：`shell: true` 会把参数直接拼成字符串，含空格的
 * 路径会被拆开。
 */
export function spawnChild(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> | undefined,
  envRemove: string[] | undefined,
  handlers: TransportHandlers,
): Transport {
  const win = process.platform === "win32";
  const file = win ? "cmd.exe" : args[0];
  const argv = win ? ["/d", "/s", "/c", ...args] : args.slice(1);

  const child = spawn(file, argv, {
    cwd,
    windowsHide: true,
    env: buildEnv(envOverrides, envRemove),
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
        // Windows 下子进程是 cmd.exe，只 kill 它不会带走 claude：
        // 用 taskkill /T 终止整棵进程树，避免取消后仍在后台跑
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          });
          return;
        }
        child.kill();
      } catch {
        // 进程可能已退出
      }
    },
    writeInput(data) {
      try {
        child.stdin?.end(data);
      } catch {
        // 进程可能已退出
      }
    },
  };
}
