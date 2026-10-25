/**
 * MCP 展示元数据
 *
 * 页面、员工绑定 Tab、选择器共用同一份来源 / 传输方式标签与配色，
 * 避免同一个枚举在多个组件里各写一份。
 */

import type { McpSource, McpTransport } from "@shared/types";

export const MCP_SOURCE_LABEL: Record<McpSource, string> = {
  "claude-global": "Claude 配置",
};

export const MCP_SOURCE_CLASS: Record<McpSource, string> = {
  "claude-global": "bg-agent-violet/10 text-agent-violet",
};

export const MCP_TRANSPORT_LABEL: Record<McpTransport, string> = {
  stdio: "stdio",
  http: "HTTP",
  sse: "SSE",
};

export const MCP_TRANSPORT_CLASS: Record<McpTransport, string> = {
  stdio: "bg-agent-teal/10 text-agent-teal",
  http: "bg-agent-sky/10 text-agent-sky",
  sse: "bg-agent-amber/10 text-agent-amber",
};
