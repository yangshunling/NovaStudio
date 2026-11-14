/**
 * 会话过程导出 —— Markdown 转录
 *
 * 输入是 getSessionWithHistory 返回的完整事件流：用户消息、正文、思考过程、
 * 工具调用与结果、错误 / 警告、token 用量。输出一份可直接分享的 Markdown。
 *
 * 取舍：
 * - 正文与思考过程不截断；
 * - 工具输入 / 输出可能非常大（整文件内容、整段日志），超过上限时截断并标注；
 * - 图片（粘贴的截图、工具返回的图片）只记录数量，不把 base64 写进文档；
 * - 流式增量（text_delta / thinking_delta）与 message_end 忽略：
 *   前者不是最终内容，后者与已收敛的块重复。
 */

import type { AgentEvent, Message, Session } from "../../shared/types";

/** 单个工具输入 / 输出的最大字符数：避免一份导出被日志撑到几十 MB */
const MAX_BLOCK_CHARS = 20_000;
const FENCE = "````";

export interface TranscriptOptions {
  /** Agent 展示名；未知时回退到 id */
  agentName: string;
  /** 消息里出现的员工 id → 名称 */
  employeeNames: Record<string, string>;
}

export function formatSessionTranscript(
  session: Session,
  options: TranscriptOptions,
): string {
  const messages = session.messages ?? [];
  const lines: string[] = [
    `# ${session.title || "未命名会话"}`,
    "",
    `- 会话 ID：\`${session.id}\``,
    `- 创建时间：${formatDateTime(session.createdAt)}`,
    `- 最后更新：${formatDateTime(session.updatedAt)}`,
    `- 工作目录：\`${session.cwd}\``,
    `- Agent：${options.agentName}`,
  ];

  if (session.employeeId) {
    lines.push(
      `- 数字员工：${options.employeeNames[session.employeeId] ?? "未知员工"}`,
    );
  }

  lines.push(
    `- 消息数：${messages.length}`,
    "",
    "> 由 Nova Studio 导出，包含完整的对话、思考过程与工具调用记录。",
    "",
  );

  if (messages.length === 0) {
    lines.push("_该会话还没有可导出的消息。_");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  for (const message of messages) {
    lines.push(
      "---",
      "",
      `## ${roleLabel(message, options)} · ${formatDateTime(message.timestamp)}`,
      "",
      renderEvents(message.content),
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** 默认文件名：去掉 Windows / Unix 非法字符，保留一个可读的标题 */
export function transcriptFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80);
  return `${cleaned || "会话导出"}.md`;
}

function roleLabel(message: Message, options: TranscriptOptions): string {
  if (message.role === "user") return "用户";
  if (message.role === "system") return "系统";
  if (message.employeeId) {
    const name = options.employeeNames[message.employeeId];
    return name ? `助手 · ${name}` : "助手";
  }
  return "助手";
}

function renderEvents(events: AgentEvent[]): string {
  const blocks: string[] = [];
  let imageCount = 0;

  for (const event of events) {
    switch (event.type) {
      case "text":
        if (event.content.trim()) blocks.push(event.content.trim());
        break;
      case "thinking":
        if (event.content.trim()) {
          blocks.push(
            [
              "<details>",
              "<summary>思考过程</summary>",
              "",
              event.content.trim(),
              "",
              "</details>",
            ].join("\n"),
          );
        }
        break;
      case "tool_call":
        blocks.push(renderToolCall(event));
        break;
      case "tool_result":
        blocks.push(renderToolResult(event));
        break;
      case "error":
        blocks.push(`> **错误**：${event.message}`);
        break;
      case "warning":
        blocks.push(`> **提示**：${event.message}`);
        break;
      case "reference":
        blocks.push(renderReference(event));
        break;
      case "image":
        imageCount += 1;
        break;
      case "usage":
        // context 是单次 API 调用的上下文快照，会频繁出现；
        // 只记录每轮结束的汇总，避免导出被用量行刷屏。
        if (event.scope !== "context") {
          blocks.push(
            `> 用量：输入 ${event.inputTokens} / 输出 ${event.outputTokens} tokens${
              event.costUsd !== undefined
                ? ` · $${event.costUsd.toFixed(4)}`
                : ""
            }`,
          );
        }
        break;
      default:
        // text_delta / thinking_delta / done / message_end：不是最终内容或与上重复
        break;
    }
  }

  if (imageCount > 0) {
    blocks.push(`> 附带 ${imageCount} 张图片（未包含在导出文件中）。`);
  }

  return blocks.length > 0 ? blocks.join("\n\n") : "_（本条消息没有可导出的内容）_";
}

const REFERENCE_LABELS: Record<
  Extract<AgentEvent, { type: "reference" }>["kind"],
  string
> = {
  file: "文件",
  session: "会话",
  tool: "工具",
  skill: "技能",
  knowledge: "知识库",
};

function renderReference(
  event: Extract<AgentEvent, { type: "reference" }>,
): string {
  const lines = [`> 引用${REFERENCE_LABELS[event.kind]}：${event.name}`];
  if (event.detail) lines.push(`> \`${event.detail}\``);
  return lines.join("\n");
}

function renderToolCall(
  event: Extract<AgentEvent, { type: "tool_call" }>,
): string {
  const parts = [`**工具调用 · \`${event.name}\`**`];
  if (event.target) parts.push(`操作对象：\`${event.target}\``);
  const input = formatValue(event.input);
  if (input) parts.push("", fenced("json", input));
  return parts.join("\n");
}

function renderToolResult(
  event: Extract<AgentEvent, { type: "tool_result" }>,
): string {
  const parts = [
    `**工具结果 · \`${event.name}\`**${event.isError ? "（失败）" : ""}`,
  ];
  if (event.output.trim()) parts.push("", fenced("text", event.output));
  if (event.images?.length) {
    parts.push(
      `> 工具返回 ${event.images.length} 张图片（未包含在导出文件中）。`,
    );
  }
  return parts.join("\n");
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function fenced(language: string, body: string): string {
  return `${FENCE}${language}\n${cap(body)}\n${FENCE}`;
}

function cap(text: string): string {
  if (text.length <= MAX_BLOCK_CHARS) return text;
  return `${text.slice(0, MAX_BLOCK_CHARS)}\n…（内容过长，已截断；原文 ${text.length} 字符）`;
}

function formatDateTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}`;
}
