/**
 * 工作流节点的执行报告
 *
 * 产物里的 `execution.md` 不再是“只有系统提示词 + 任务详情”的请求文件，
 * 而是这次调用 Claude（或其他 Agent）的完整现场：
 * - 运行 / 工作流 / 节点 / 员工 / 尝试等身份信息
 * - Agent 平台、模型、权限、Base URL 等本机配置快照
 * - 实际注入的 MCP / Skill / 知识库清单
 * - provider 真正启动子进程时的 argv、cwd、额外环境变量
 * - 告警、系统提示词、stdin 内容与执行结果
 *
 * 敏感值（API Key、TOKEN、SECRET 等）在写入前统一脱敏。
 */

import type { AgentInvocationInfo } from "../agents/types";

export interface ExecutionReportKnowledgeBase {
  name: string;
  path: string;
  fileCount: number;
}

export interface ExecutionReportInput {
  runId: string;
  workflowId: string;
  workflowName: string;
  workspacePath: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  employeeId: string;
  employeeName: string;
  employeeRole: string;
  attempt: number;
  /** 该尝试内的修正轮次，从 1 开始 */
  round: number;
  /** initial / retry / revise */
  kind: string;
  maxRetries: number;
  maxRevisions: number;
  failureStrategy: string;
  reviewMode: string;
  startedAt: number;
  timeoutMinutes: number | null;
  sessionId: string | null;
  sessionRef: string | null;
  agentLabel: string;
  runtimeConfig: Record<string, string>;
  runtimeDir: string | null;
  prepared: {
    configDir?: string | null;
    env?: Record<string, string>;
    envRemove?: string[];
    extraArgs?: string[];
    injected?: { mcpServers: string[]; skills: string[] };
  } | null;
  invocation: AgentInvocationInfo | null;
  knowledge: ExecutionReportKnowledgeBase[];
  warnings: string[];
  systemPrompt: string;
  prompt: string;
  outcome: {
    ok: boolean;
    exitCode: number;
    duration: number;
    aborted: boolean;
    error?: string;
  } | null;
  error: string | null;
}

const SECRET_KEY = /(token|secret|password|passwd|auth|api[-_]?key|access[-_]?key|credential)/i;

function formatTime(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
}

/** 表格单元格：避免值里的换行 / 竖线破坏 Markdown 表格 */
function cell(value: unknown): string {
  return String(value ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function maskEnv(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) =>
    SECRET_KEY.test(key)
      ? `${key}=（已隐藏，长度 ${value.length}）`
      : `${key}=${value}`,
  );
}

/** 用比正文更长的反引号围栏，避免正文里的 ``` 提前结束代码块 */
function codeBlock(content: string, language = "text"): string {
  const longest = Math.max(
    3,
    ...(content.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${content}\n${fence}`;
}

function bullets(items: string[], empty = "（无）"): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function displayArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function resultText(input: ExecutionReportInput): string {
  if (input.error) return `失败（执行异常）：${input.error}`;
  if (!input.outcome) return "运行中 / 尚未开始";
  if (input.outcome.aborted) {
    return `已中断（耗时 ${formatDurationMs(input.outcome.duration)}）`;
  }
  if (!input.outcome.ok) {
    return `失败（${input.outcome.error || `exit ${input.outcome.exitCode}`}）`;
  }
  const state = input.outcome.exitCode === 0 ? "成功" : "失败";
  const detail =
    input.outcome.exitCode === 0
      ? "exit 0"
      : `exit ${input.outcome.exitCode}${input.outcome.error ? `：${input.outcome.error}` : ""}`;
  return `${state}（${detail}，耗时 ${formatDurationMs(input.outcome.duration)}）`;
}

export function buildExecutionReport(input: ExecutionReportInput): string {
  const lines: string[] = [];

  lines.push(
    "# 工作流节点执行信息",
    "",
    "> 本文件记录本次节点尝试的完整执行上下文，用于排查参数 / 配置问题。",
    "> API Key、TOKEN、SECRET 等敏感环境变量已脱敏。",
    "",
    "## 基本信息",
    "",
    "| 项目 | 值 |",
    "| --- | --- |",
    `| 运行 ID | ${cell(input.runId)} |`,
    `| 工作流 | ${cell(input.workflowName)} |`,
    `| 工作流 ID | ${cell(input.workflowId)} |`,
    `| 节点 | ${cell(input.nodeName)} |`,
    `| 节点 ID | ${cell(input.nodeId)} |`,
    `| 节点类型 | ${cell(input.nodeType)} |`,
    `| 数字员工 | ${cell(`${input.employeeName}（${input.employeeId}）`)} |`,
    `| 员工职位 | ${cell(input.employeeRole || "—")} |`,
    `| 尝试次数 | 第 ${input.attempt} 次（最多重试 ${input.maxRetries} 次） |`,
    `| 调用来源 | ${cell(input.kind === "revise" ? "人工审核要求修改" : input.kind === "retry" ? "执行失败重试" : "初次执行")} |`,
    `| 修正轮次 | 第 ${input.round} 轮 / 最多 ${input.maxRevisions} 轮 |`,
    `| 失败策略 | ${cell(input.failureStrategy)} |`,
    `| 审核门禁 | ${cell(input.reviewMode)} |`,
    `| 会话 ID | ${cell(input.sessionId ?? "尚未创建")} |`,
    `| CLI 会话 ID | ${cell(input.sessionRef ?? "尚未生成 / 未持久化")} |`,
    `| 工作目录 | ${cell(input.workspacePath)} |`,
    `| 开始时间 | ${cell(formatTime(input.startedAt))} |`,
    `| 单次超时 | ${input.timeoutMinutes ? `${input.timeoutMinutes} 分钟` : "使用默认值"} |`,
    `| 执行结果 | ${cell(resultText(input))} |`,
    "",
  );

  lines.push("## Agent 平台与本机配置", "", "| 项目 | 值 |", "| --- | --- |");
  lines.push(`| Agent | ${cell(input.agentLabel)} |`);
  const runtimeEntries = Object.entries(input.runtimeConfig);
  if (runtimeEntries.length === 0) {
    lines.push("| 本机配置 | Provider 未提供配置摘要 |");
  } else {
    for (const [key, value] of runtimeEntries) {
      lines.push(`| ${cell(key)} | ${cell(value)} |`);
    }
  }
  lines.push("");

  const injected = input.prepared?.injected;
  lines.push("## 注入的能力", "");
  lines.push(
    `### MCP 服务（${injected?.mcpServers.length ?? 0} 个）`,
    "",
    injected
      ? bullets(injected.mcpServers)
      : "Provider 未提供 MCP 注入清单（可能直接使用 CLI 本机配置）。",
    "",
    `### 技能（${injected?.skills.length ?? 0} 个）`,
    "",
    injected
      ? bullets(injected.skills)
      : "Provider 未提供技能注入清单（可能直接使用 CLI 本机配置）。",
    "",
    `### 知识库（${input.knowledge.length} 个）`,
    "",
    input.knowledge.length > 0
      ? bullets(
          input.knowledge.map(
            (base) => `${base.name} — ${base.path}（${base.fileCount} 个文件）`,
          ),
        )
      : "（无）",
    "",
  );

  lines.push("## 实际执行参数", "");
  if (input.invocation) {
    const { invocation } = input;
    // provider 的 args 通常已包含可执行文件；没有时补上，避免命令行重复
    const argv =
      invocation.args[0] === invocation.command
        ? invocation.args
        : [invocation.command, ...invocation.args];
    const commandLine = argv.map(displayArg).join(" ");
    lines.push(
      "命令行（按参数顺序展开，路径中的临时文件在节点结束后会被删除）：",
      "",
      codeBlock(commandLine),
      "",
      "argv（精确边界）：",
      "",
      codeBlock(argv.map((arg, index) => `[${index}] ${arg}`).join("\n")),
      "",
      `工作目录：${invocation.cwd}`,
      `stdin：${invocation.stdin ?? "（无）"}`,
      "",
    );

    const envLines = maskEnv(invocation.env);
    lines.push(
      "额外环境变量：",
      "",
      bullets(envLines),
      "",
      "移除的环境变量：",
      "",
      bullets(invocation.envRemove ?? []),
      "",
    );

    if (invocation.notes?.length) {
      lines.push("说明：", "", bullets(invocation.notes), "");
    }
  } else {
    lines.push(
      "尚未获取到实际命令行：CLI 在启动前就失败了，或 provider 未回调调用信息。",
      "",
    );
    if (input.prepared?.extraArgs?.length) {
      lines.push(
        "Provider 准备的额外参数：",
        "",
        codeBlock(input.prepared.extraArgs.join("\n")),
        "",
      );
    }
  }

  if (input.runtimeDir) {
    lines.push(`运行时投影目录（节点结束后删除）：${input.runtimeDir}`, "");
  }
  if (input.prepared?.configDir) {
    lines.push(`本次 CLI 配置目录：${input.prepared.configDir}`, "");
  }

  lines.push(
    "## 运行告警",
    "",
    bullets(input.warnings),
    "",
    "## 系统提示词",
    "",
    input.systemPrompt.trim() ? codeBlock(input.systemPrompt) : "（无）",
    "",
    "## 任务输入（stdin）",
    "",
    codeBlock(input.prompt),
    "",
  );

  return lines.join("\n");
}
