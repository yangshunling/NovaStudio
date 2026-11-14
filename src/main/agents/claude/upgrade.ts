/**
 * Claude Code 版本检测与升级
 *
 * 检测不产生副作用：先查 npm registry 的 latest 版本，失败时退回 `npm view`。
 * 安装只在未安装时执行 `npm install -g`；升级优先调用 Claude Code 自带的
 * `claude update`（它能识别原生安装与包管理器安装）；若没有实际生效，再按
 * Nova 的安装命令回退到 npm 全局升级。
 *
 * 命令行仍复用 transport 的平台适配：Windows 下经 cmd.exe 解析 .cmd 入口，
 * 超时用任务树终止，避免 npm 的孙进程继续在后台写入全局目录。
 */

import { homedir } from "os";
import type {
  AgentInstallResult,
  AgentUpgradeCheck,
  AgentUpgradeResult,
} from "../../../shared/contracts/agent";
import { probeVersion } from "../probe";
import { execCli, spawnChild, stripAnsi } from "../transport";
import { errorMessage } from "../../../shared/error";

const BIN = "claude";
const NPM_PACKAGE = "@anthropic-ai/claude-code";
const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;

/** registry 查询上限；超时即走 npm view 兜底 */
const CHECK_TIMEOUT_MS = 20_000;
/** npm view 首次冷启动可能要十几秒 */
const NPM_VIEW_TIMEOUT_MS = 60_000;
/** 升级可能是下载完整二进制，留足时间 */
const UPGRADE_TIMEOUT_MS = 10 * 60_000;
/** 推给界面的升级日志上限，避免 npm 进度条把内存与 DOM 撑爆 */
const OUTPUT_LIMIT = 32 * 1024;

/** 同一时间只允许一个升级任务：npm 全局安装目录不能并发写 */
let inFlight = false;

/** 把 `2.1.322` / `v2.1.0-beta.1` 拆成可比较的片段 */
function parseVersion(version: string): { parts: number[]; pre: string } {
  const cleaned = version.trim().replace(/^v/i, "").split(/\s+/)[0] ?? "";
  const [core, ...rest] = cleaned.split("-");
  const parts = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return { parts, pre: rest.join("-") };
}

/** 语义化版本比较：>0 表示 a 比 b 新 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < length; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // 版本号相同时，稳定版高于预发布版（semver 规则）
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  return left.pre.localeCompare(right.pre);
}

interface LatestVersion {
  version?: string;
  source: string;
  error?: string;
}

/**
 * 获取 npm 上的最新版本。
 *
 * 主路径直接请求 registry：不依赖本机 npm 是否在 GUI 进程的 PATH 里，
 * 也没有命令副作用。registry 不可达时（例如只有 npm 配了代理）退回
 * `npm view`，让 npm 自己的代理配置生效。
 */
async function fetchLatestVersion(): Promise<LatestVersion> {
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== "string" || !body.version.trim()) {
      throw new Error("registry 未返回版本号");
    }
    return { version: body.version.trim(), source: "npm registry" };
  } catch (registryError) {
    try {
      const stdout = await execCli(
        ["npm", "view", NPM_PACKAGE, "version"],
        NPM_VIEW_TIMEOUT_MS,
      );
      const match = stdout.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
      if (!match) throw new Error("未解析到版本号");
      return { version: match[0], source: "npm view" };
    } catch (npmError) {
      return {
        source: "npm registry",
        error: `无法获取最新版本：${errorMessage(registryError)}；npm view 也失败：${errorMessage(npmError)}`,
      };
    }
  }
}

interface CommandResult {
  code: number;
  output: string;
  timedOut: boolean;
}

/** 执行一条升级命令，边收集输出边通过回调推送 */
function runCommand(
  args: string[],
  timeoutMs: number,
  onOutput?: (chunk: string) => void,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const append = (raw: string): void => {
      const text = stripAnsi(raw);
      if (!text) return;
      output = (output + text).slice(-OUTPUT_LIMIT);
      onOutput?.(text);
    };

    const transport = spawnChild(
      args,
      homedir(),
      undefined,
      undefined,
      {
        onData: append,
        onStderr: append,
        onExit: (code) => {
          if (timer) clearTimeout(timer);
          resolve({ code, output, timedOut });
        },
      },
    );

    timer = setTimeout(() => {
      timedOut = true;
      // transport.kill 在 Windows 上会终止整棵进程树
      transport.kill();
    }, timeoutMs);

    // 升级命令不读 stdin；保持打开可能让某些包管理器等待输入
    transport.writeInput("");
  });
}

/** 检查是否安装了 Claude Code、是否有新版本；无副作用 */
export async function checkClaudeUpgrade(): Promise<AgentUpgradeCheck> {
  const status = await probeVersion(BIN);
  if (!status.installed) {
    return { updateAvailable: false, error: "未检测到 Claude Code，请先安装" };
  }

  const latest = await fetchLatestVersion();
  return {
    installedVersion: status.version,
    latestVersion: latest.version,
    updateAvailable: Boolean(
      status.version &&
        latest.version &&
        compareVersions(latest.version, status.version) > 0,
    ),
    source: latest.source,
    error: latest.error,
  };
}

/** `claude update` 在无需升级时的固定文案 */
const UP_TO_DATE = /is up to date|already (?:on|using) the latest/i;

/** 命令找不到 npm 时的常见输出（中英文 shell 文案） */
const NPM_NOT_FOUND =
  /not recognized|不是内部或外部命令|command not found|ENOENT|无法将.*识别/i;

/**
 * 安装 Claude Code 到本机。
 *
 * 与升级共用同一把 inFlight 锁：npm 全局安装目录不能被并发写。
 * 只走 npm 全局安装（与 manifest.installCommand 一致），因为 Nova 需要
 * 一个能在 PATH 里直接执行的 `claude`；原生安装器的落点由 CLI 自己管理，
 * 不适合由宿主假定。
 */
export async function installClaude(
  onOutput?: (chunk: string) => void,
): Promise<AgentInstallResult> {
  if (inFlight) {
    return { ok: false, error: "已有安装或升级任务正在进行，请稍候" };
  }
  inFlight = true;

  try {
    // 已安装时不重复执行 npm 全局写操作
    const existing = await probeVersion(BIN);
    if (existing.installed) {
      return {
        ok: true,
        version: existing.version,
        output: "Claude Code 已安装，无需重复安装。",
      };
    }

    let collected = "";
    const emit = (chunk: string): void => {
      collected = (collected + chunk).slice(-OUTPUT_LIMIT);
      onOutput?.(chunk);
    };

    emit(`正在安装 ${NPM_PACKAGE}…\n> npm install -g ${NPM_PACKAGE}@latest\n`);

    const result = await runCommand(
      ["npm", "install", "-g", `${NPM_PACKAGE}@latest`],
      UPGRADE_TIMEOUT_MS,
      emit,
    );

    if (result.timedOut) {
      return {
        ok: false,
        output: collected,
        error: "安装超时，请检查网络后重试",
      };
    }

    if (result.code !== 0) {
      return {
        ok: false,
        output: collected,
        error: NPM_NOT_FOUND.test(result.output)
          ? "未找到 npm，请先安装 Node.js（附带 npm），或按下方命令手动安装"
          : "安装命令执行失败，详情见上方日志",
      };
    }

    /*
     * 安装成功但探测不到，通常是当前进程的 PATH 还是启动时的快照。
     * 这里不直接报“失败”，把原因说清楚，用户重启 Nova 即可。
     */
    const after = await probeVersion(BIN);
    if (!after.installed) {
      return {
        ok: false,
        output: collected,
        error: "安装命令已执行，但当前进程还找不到 claude；请重启 Nova 刷新 PATH 后重试",
      };
    }

    return { ok: true, version: after.version, output: collected };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    inFlight = false;
  }
}

/**
 * 升级到最新版本。
 *
 * 以 CLI 自己为准：`claude update` 能按安装方式选择正确的升级通道，
 * 不先查 registry —— 否则断网时要在检测上白等一分多钟才开始升级。
 * 对包管理器托管的安装，它可能只给出提示而不落盘；这时按 Nova 的
 * 安装命令回退到 `npm install -g`，保证按钮按下去真的完成升级。
 */
export async function upgradeClaude(
  onOutput?: (chunk: string) => void,
): Promise<AgentUpgradeResult> {
  if (inFlight) {
    return { ok: false, error: "已有安装或升级任务正在进行，请稍候" };
  }
  inFlight = true;

  try {
    const before = await probeVersion(BIN);
    if (!before.installed) {
      return { ok: false, error: "未检测到 Claude Code，请先安装" };
    }

    let collected = "";
    const emit = (chunk: string): void => {
      collected = (collected + chunk).slice(-OUTPUT_LIMIT);
      onOutput?.(chunk);
    };

    emit("正在检查并升级 Claude Code…\n");

    const primary = await runCommand([BIN, "update"], UPGRADE_TIMEOUT_MS, emit);
    let after = await probeVersion(BIN);

    const changed = Boolean(
      before.version &&
        after.version &&
        compareVersions(after.version, before.version) > 0,
    );

    // 只在“没有升上去”时回退；已经成功就不再碰 npm 安装目录。
    // 退码非 0 说明 CLI 自己处理不了（例如旧版本没有 update 子命令），
    // 输出里提到包管理器则说明它把升级交给了外部工具。
    if (!changed && !UP_TO_DATE.test(primary.output)) {
      const managesExternally =
        /package manager|managed by|npm|pnpm|yarn|brew/i.test(primary.output);
      if (primary.code !== 0 || managesExternally) {
        emit(`\n[回退] npm install -g ${NPM_PACKAGE}@latest\n`);
        await runCommand(
          ["npm", "install", "-g", `${NPM_PACKAGE}@latest`],
          UPGRADE_TIMEOUT_MS,
          emit,
        );
        after = await probeVersion(BIN);
      }
    }

    const output = collected;
    const version = after.version;
    const updated = Boolean(
      before.version && version && compareVersions(version, before.version) > 0,
    );
    // CLI 明确说已是最新，且版本确实没变，也视为成功
    const selfReportedUpToDate = !changed && UP_TO_DATE.test(output);

    if (updated || selfReportedUpToDate) {
      return {
        ok: true,
        previousVersion: before.version,
        version,
        output,
      };
    }

    return {
      ok: false,
      previousVersion: before.version,
      version,
      output,
      error: primary.timedOut
        ? "升级超时，请检查网络后重试"
        : primary.code !== 0
          ? "升级命令执行失败，详情见上方日志"
          : "升级命令已执行，但版本未发生变化",
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    inFlight = false;
  }
}
