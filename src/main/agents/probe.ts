/**
 * 版本探测 —— 各 provider 的 detect() 共用
 *
 * 与 transport 的执行器共用同一套「参数数组 + 平台适配」：
 * Windows 上经 cmd.exe 解析 npm 全局安装的 .cmd 入口，其余平台直接 execFile。
 * provider 只传可执行文件名与参数，不拼命令行字符串 —— 避免引号拼接风险。
 *
 * 用异步执行器：detect 在应用启动时批量调用，不能阻塞主进程。
 */

import type { AgentStatus } from "../../shared/contracts/agent";
import { execCli } from "./transport";

const DETECT_TIMEOUT_MS = 10_000;

/** 执行 `<bin> --version` 并解析版本号；命令失败即视为未安装 */
export async function probeVersion(
  bin: string,
  args: readonly string[] = ["--version"],
): Promise<AgentStatus> {
  try {
    const stdout = await execCli([bin, ...args], DETECT_TIMEOUT_MS);
    return { installed: true, version: parseVersion(stdout) };
  } catch {
    return { installed: false };
  }
}

/** 从命令输出中提取版本号 */
function parseVersion(output: string): string | undefined {
  const match = output.match(/v?(\d+\.\d+\.\d+(?:[.-][A-Za-z0-9]+)?)/);
  return match?.[1] ?? (output.trim() || undefined);
}
