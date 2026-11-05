import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExecutionReport,
  type ExecutionReportInput,
} from "../src/main/workflow/execution-report.ts";

function baseInput(overrides: Partial<ExecutionReportInput> = {}): ExecutionReportInput {
  return {
    runId: "964973d4-1a3a-400c-8ebb-c95c641a08d1",
    workflowId: "c7157f04-e303-4e6e-b58e-d0cc11a1bed6",
    workflowName: "demo",
    workspacePath: "C:\\work\\demo",
    nodeId: "n1",
    nodeName: "需求分析",
    nodeType: "employee",
    employeeId: "e1",
    employeeName: "需求工程师",
    employeeRole: "需求开发",
    attempt: 1,
    round: 1,
    kind: "initial",
    maxRetries: 0,
    maxRevisions: 1,
    failureStrategy: "stop",
    reviewMode: "auto",
    startedAt: Date.UTC(2026, 10, 3, 2, 32, 24),
    timeoutMinutes: 30,
    sessionId: "s1",
    sessionRef: null,
    agentLabel: "Claude Code（claude）",
    runtimeConfig: {
      "默认模型": "deepseek-flash[1M]",
      "权限模式": "acceptEdits",
    },
    runtimeDir: "C:\\userdata\\workflow-runs\\run1\\n1-attempt-1",
    prepared: {
      configDir: "C:\\userdata\\workflow-runs\\run1\\n1-attempt-1\\claude-home",
      env: {
        CLAUDE_CONFIG_DIR: "C:\\userdata\\workflow-runs\\run1\\n1-attempt-1\\claude-home",
        ANTHROPIC_API_KEY: "sk-secret-value",
      },
      envRemove: ["ANTHROPIC_BASE_URL"],
      injected: { mcpServers: ["filesystem"], skills: ["pdf"] },
    },
    invocation: {
      command: "claude",
      args: [
        "claude",
        "-p",
        "--output-format",
        "stream-json",
        "--mcp-config",
        "C:\\tmp\\mcp.json",
      ],
      cwd: "C:\\work\\demo",
      stdin: "任务输入（prompt 通过 stdin 传入）",
      env: {
        CLAUDE_CONFIG_DIR: "C:\\userdata\\workflow-runs\\run1\\n1-attempt-1\\claude-home",
        ANTHROPIC_API_KEY: "sk-secret-value",
      },
      envRemove: ["ANTHROPIC_BASE_URL"],
      notes: ["prompt 通过 stdin 传入"],
    },
    knowledge: [
      { name: "产品文档", path: "C:\\kb\\product", fileCount: 12 },
    ],
    warnings: ["技能「x」不存在，已跳过"],
    systemPrompt: "你是需求工程师。",
    prompt: "请分析需求。",
    outcome: { ok: true, exitCode: 0, duration: 65_000, aborted: false },
    error: null,
    ...overrides,
  };
}

test("执行报告包含配置、注入清单、命令行与结果", () => {
  const report = buildExecutionReport(baseInput());

  assert.match(report, /工作流 ID \| c7157f04/);
  assert.match(report, /运行 ID \| 964973d4/);
  assert.match(report, /默认模型 \| deepseek-flash\[1M\]/);
  assert.match(report, /权限模式 \| acceptEdits/);
  assert.match(report, /调用来源 \| 初次执行/);
  assert.match(report, /修正轮次 \| 第 1 轮 \/ 最多 1 轮/);
  assert.match(report, /MCP 服务（1 个）/);
  assert.match(report, /filesystem/);
  assert.match(report, /技能（1 个）/);
  assert.match(report, /pdf/);
  assert.match(report, /产品文档 — C:\\kb\\product（12 个文件）/);
  assert.match(report, /claude -p --output-format stream-json/);
  assert.match(report, /CLAUDE_CONFIG_DIR=C:\\userdata/);
  assert.match(report, /ANTHROPIC_BASE_URL/);
  assert.match(report, /成功（exit 0，耗时 1 分 5 秒）/);
  assert.match(report, /你是需求工程师。/);
  assert.match(report, /请分析需求。/);
});

test("敏感环境变量值不会写入报告", () => {
  const report = buildExecutionReport(baseInput());
  assert.equal(report.includes("sk-secret-value"), false);
  assert.match(report, /ANTHROPIC_API_KEY=（已隐藏，长度 \d+）/);
});

test("未获取到调用信息时明确说明", () => {
  const report = buildExecutionReport(
    baseInput({ invocation: null, prepared: null, outcome: null }),
  );
  assert.match(report, /尚未获取到实际命令行/);
  assert.match(report, /运行中 \/ 尚未开始/);
});
