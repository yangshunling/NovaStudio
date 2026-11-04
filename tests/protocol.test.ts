import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { AgentEvent } from "../src/shared/types.ts";
import type { RunResult } from "../src/main/agents/types.ts";
import { isResumeFailure } from "../src/main/agents/resume-error.ts";

/**
 * line-run / parse 都使用无扩展名的相对导入（由 Vite 解析），
 * Node 的类型剥离无法直接加载。用 esbuild 打包成 data URL 后再导入，
 * 保证测的是真实源码。
 */
async function bundle(relative: string): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(relative, import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  return `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
}

const [lineRun, parse] = await Promise.all([
  import(await bundle("../src/main/agents/line-run.ts")) as Promise<
    typeof import("../src/main/agents/line-run.ts")
  >,
  import(await bundle("../src/main/agents/claude/parse.ts")) as Promise<
    typeof import("../src/main/agents/claude/parse.ts")
  >,
]);

interface LineRunOutcome {
  events: AgentEvent[];
  result: RunResult;
  sessionIds: string[];
}

/** 用 node 自身当被测 CLI，避免测试依赖 claude */
function runNode(
  script: string,
  options: {
    extraArgs?: string[];
    decode?: (line: string) => AgentEvent | AgentEvent[] | null;
  } = {},
): Promise<LineRunOutcome> {
  return new Promise((resolve) => {
    const events: AgentEvent[] = [];
    const sessionIds: string[] = [];
    const session = lineRun.startLineRun(
      {
        args: [process.execPath, "-e", script, ...(options.extraArgs ?? [])],
        cwd: process.cwd(),
        timeoutMs: 8000,
        extractSessionId(line) {
          try {
            const obj = JSON.parse(line) as { session_id?: unknown };
            return typeof obj.session_id === "string" ? obj.session_id : null;
          } catch {
            return null;
          }
        },
        decode:
          options.decode ??
          ((line) => {
            try {
              JSON.parse(line);
              return { type: "text", content: "decoded" };
            } catch {
              return null;
            }
          }),
      },
      {
        onEvent(event) {
          events.push(event);
        },
        onSessionId(id) {
          sessionIds.push(id);
        },
      },
    );
    void session.done.then((result) => resolve({ events, result, sessionIds }));
  });
}

test("非零退出：stderr 被当作诊断上报，并写入 RunResult.error", async () => {
  const { events, result } = await runNode(
    "process.stderr.write('boom stderr\\n'); process.exit(2);",
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.error ?? "", /boom stderr/);
  const errors = events.filter((e) => e.type === "error");
  assert.equal(errors.length, 1);
  assert.match(
    errors[0].type === "error" ? errors[0].message : "",
    /boom stderr/,
  );
});

test("非零退出但没有 stderr：给出退出码错误，不再静默", async () => {
  const { events, result } = await runNode("process.exit(3);");
  assert.equal(result.exitCode, 3);
  const errors = events.filter((e) => e.type === "error");
  assert.equal(errors.length, 1);
  assert.match(
    errors[0].type === "error" ? errors[0].message : "",
    /退出码 3/,
  );
});

test("stdout 与 stderr 交错不会拼坏 stdout 的 JSON 行", async () => {
  // 一条 JSON 分两段写，中间插入 stderr
  const script =
    "process.stdout.write(JSON.stringify({session_id:'sid-1'}).slice(0,-1));" +
    "process.stderr.write('warning line\\n');" +
    "process.stdout.write('}\\n');";
  const { events, result, sessionIds } = await runNode(script);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(sessionIds, ["sid-1"]);
  assert.equal(
    events.filter((e) => e.type === "text" && e.content === "decoded").length,
    1,
  );
});

test("Windows 下参数中的 & 不会被 cmd 拆成额外命令", async () => {
  // 若引号处理不正确，cmd 会在 & 处截断并执行 "b"
  const { result } = await runNode("console.log('ok')", {
    extraArgs: ["a&b"],
  });
  assert.equal(result.exitCode, 0);
});

test("进程已 exit 但孙进程持有管道时，500ms 兜底收尾", async () => {
  /*
   * 直接子进程立即退出，但 detached 孙进程继承 stdout/stderr，
   * 正常 close 要等孙进程结束（这里 5s）。没有 exit 兜底时，
   * 会话会一直停在“运行中”。
   */
  const script =
    "const {spawn}=require('child_process');" +
    "spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:['ignore','inherit','inherit'],detached:true});" +
    "process.exit(0);";

  const startedAt = Date.now();
  const { result } = await runNode(script);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.exitCode, 0);
  assert.ok(elapsed < 3000, `应在兜底宽限内结束，实际 ${elapsed}ms`);
});

test("result 错误子类型会上报为 error", () => {
  const decoder = parse.createDecoder(false);
  const event = decoder(
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["No conversation found with session ID: abc"],
    }),
  );
  assert.deepEqual(event, {
    type: "error",
    message: "No conversation found with session ID: abc",
  });
});

test("识别 resume 失效文案（用于清空旧会话引用）", () => {
  assert.equal(
    isResumeFailure("No conversation found with session ID: abc"),
    true,
  );
  assert.equal(
    isResumeFailure("No conversation found with session ID: abc\nsome warning"),
    true,
  );
  assert.equal(isResumeFailure("Agent 进程退出码 1"), false);
  assert.equal(isResumeFailure(undefined), false);
});

test("result 成功子类型不产生事件", () => {
  const decoder = parse.createDecoder(false);
  assert.equal(
    decoder(JSON.stringify({ type: "result", subtype: "success", is_error: false })),
    null,
  );
});
