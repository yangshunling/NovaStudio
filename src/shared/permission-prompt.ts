/**
 * 工具授权询问：Claude Code 在 `--permission-prompt-tool stdio` 下
 * 通过控制通道发来的 `can_use_tool` 负载。
 *
 * 这类请求是带外的：不落库、不进入 AgentEvent、不参与历史回放。
 * 宿主收到后弹出「允许 / 拒绝」，把回答编码成 control_response 写回
 * 子进程 stdin。
 */

/** CLI 给出的授权建议（切换模式 / 添加目录等），当前只展示不自动应用 */
export interface PermissionSuggestion {
  type: string;
  mode?: string;
  directories?: string[];
  destination?: string;
  [key: string]: unknown;
}

/** 归一化后的权限询问（不含传输与路由字段） */
export interface PermissionPromptRequest {
  /** CLI control_request 的 request_id */
  requestId: string;
  toolName: string;
  /** 工具展示名；CLI 未提供时等于 toolName */
  displayName: string;
  /** 一句话说明：命令内容 / 文件路径等 */
  description: string;
  /** 工具原始入参；允许时原样回传 updatedInput */
  input: unknown;
  permissionSuggestions: PermissionSuggestion[];
  /** 为什么需要询问（如 "Path is outside allowed working directories"） */
  decisionReason?: string;
  decisionReasonType?: string;
  toolUseId?: string;
}

/** 推给渲染层的视图：补上会话路由与超时信息 */
export interface PermissionPromptView extends PermissionPromptRequest {
  sessionId: string;
  createdAt: number;
  /** 安全超时截止时间，供界面展示 */
  expiresAt: number;
}

/** 宿主对一次询问的回答（最终写进 control_response.response） */
export type PermissionPromptDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string; interrupt?: boolean };

/** 请求从待处理列表移除的原因 */
export type PermissionResolvedReason =
  | "answered"
  | "aborted"
  | "timeout"
  | "canceled"
  | "unavailable"
  | "session-deleted"
  | "window-closed"
  | "run-ended";

/** 主进程 → 渲染层：某条请求已失效 */
export interface PermissionPromptResolved {
  sessionId: string;
  requestId: string;
  reason: PermissionResolvedReason;
  behavior?: "allow" | "deny";
}

/** 渲染层回答后的结果 */
export type PermissionRespondResult =
  | { ok: true }
  | { ok: false; error: string };
