/**
 * 领域模型层 — 主进程与渲染进程共用的数据模型
 *
 * 分层约定：
 * - 本文件：领域模型（项目 / 会话 / 消息 / 事件 / 自动化任务 / 设置）
 * - contracts/agent.ts：Agent 元数据契约（manifest / capabilities / status）
 * - contracts/skin.ts：皮肤契约
 * - contracts/ipc.ts：IPC 通道契约（通道名 + 参数 + 返回值）
 *
 * 具体 Agent 的实现协议（provider / run session / 历史读取）不在 shared 层，
 * 见 src/main/agents/types.ts。
 */

// ============================================================================
// Agent 调用参数
// ============================================================================

/**
 * 单次调用的运行参数。
 *
 * 宿主**不解释**这里的键与值 —— 键由 AgentManifest.options 声明，
 * provider 负责把键映射到自己的命令行开关。因此任何 Agent 新增自己
 * 独有的参数（模型 / 思考档位 / 权限模式 / 温度 / 轮数上限 …）都无需改动本文件。
 */
export type SessionOptions = Record<string, string>;

// ============================================================================
// 事件类型 — 流式输出的统一模型
// ============================================================================

/**
 * 工具调用的展示分类。
 *
 * 由 provider 的解析层判定（它才知道自己的工具叫什么），宿主据此选择图标与
 * 呈现方式 —— 宿主不出现任何具体工具名。
 */
export type ToolKind = "read" | "write" | "exec" | "search" | "other";

export type AgentEvent =
  | { type: "thinking"; content: string }
  | { type: "text"; content: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | {
      type: "tool_call";
      /** Agent 协议内的稳定调用 id，用于精确配对 tool_result */
      callId?: string;
      name: string;
      input: unknown;
      /** 展示分类：决定图标与配色 */
      kind: ToolKind;
      /** 操作对象原文（路径 / 命令 / 模式串）。是否缩短由展示层决定 */
      target: string;
    }
  | {
      type: "tool_result";
      /** 对应 tool_call.callId */
      callId?: string;
      name: string;
      output: string;
      isError?: boolean;
    }
  | { type: "error"; message: string }
  /**
   * 非致命提示：CLI 自己标记为「警告」的条目（如输出被截断）。
   * 与 error 分开，避免把「运行仍在继续」的提示渲染成红色失败。
   */
  | { type: "warning"; message: string }
  | { type: "done" }
  | { type: "message_end"; blocks: AgentEvent[] };

/** 事件类型枚举，用于 UI 路由 */
export type AgentEventType = AgentEvent["type"];

// ============================================================================
// 项目 / 会话模型
// ============================================================================

/**
 * 项目 = 一个工作文件夹 + 名字。
 * 项目下的所有会话共享该 cwd，Agent 在此目录运行，相对路径与多轮上下文一致。
 */
export interface Project {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

/** 会话从属于一个项目 */
export interface Session {
  id: string;
  projectId: string;
  /** 对应 AgentManifest.id */
  agentId: string;
  /**
   * CLI 侧会话引用。语义由该 Agent 的 provider 解释（可能是文件路径，也可能是
   * 数据库主键），宿主只负责原样存取与回传。首轮对话完成前为 null。
   */
  agentSessionId: string | null;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** 消息数（仅索引用，正文不入库；UI 展示历史时由 provider 回放） */
  messageCount?: number;
  /** 仅 session:get 时由 provider 回放填充；listSessions 返回空数组 */
  messages?: Message[];
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: AgentEvent[];
  timestamp: number;
}

// ============================================================================
// 文件条目 — @ 提及文件选择
// ============================================================================

export interface FileEntry {
  name: string;
  /** 相对于项目根目录的路径（正斜杠分隔） */
  relativePath: string;
  isDirectory: boolean;
}

// ============================================================================
// Git 工作区状态 — 文件树标记
// ============================================================================

export type GitStatusKind =
  | "untracked"
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "conflicted"
  | "changed";

export interface GitFileStatus {
  /** 相对于当前项目根目录的路径（正斜杠分隔） */
  relativePath: string;
  status: GitStatusKind;
}

export interface GitStatusSummary {
  /** 当前目录是否位于 Git 工作区，且 git 命令可用 */
  available: boolean;
  branch: string | null;
  files: GitFileStatus[];
}

// ============================================================================
// 文件预览 — 工作区文件只读打开
// ============================================================================

export type FilePreviewKind = "text" | "markdown" | "image" | "pdf" | "binary";

export interface FilePreview {
  name: string;
  relativePath: string;
  kind: FilePreviewKind;
  mimeType: string;
  size: number;
  language?: string;
  content?: string;
  dataUrl?: string;
  truncated?: boolean;
  note?: string;
}

export type ReadFileResult =
  | { ok: true; file: FilePreview }
  | { ok: false; error: string };

export interface OpenFileExternalResult {
  ok: boolean;
  error?: string;
}

// ============================================================================
// 系统终端
// ============================================================================

export interface TerminalCreateResult {
  id: string;
  cwd: string;
  shell: string;
}

export interface TerminalDataPayload {
  id: string;
  data: string;
}

export interface TerminalExitPayload {
  id: string;
  exitCode: number;
  signal?: number;
}

// ============================================================================
// 自动化任务
// ============================================================================

export type AutomationStatus = "pending" | "running" | "completed" | "failed";

/**
 * 自动化任务 — 用户录入自然语言指令，绑定项目与 Agent，
 * 由主进程轮询器自动拾取、创建会话、调 Agent 执行。
 * 执行详情通过 sessionId 关联的会话消息查看。
 */
export interface AutomationTask {
  id: string;
  prompt: string;
  projectId: string;
  agentId: string;
  status: AutomationStatus;
  /** 任务执行时创建的会话 ID，用于查看执行详情 */
  sessionId: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
}

// ============================================================================
// 数字员工
// ============================================================================

/** 数字员工可调用的 MCP 服务配置 */
export interface EmployeeMcpServer {
  id: string;
  name: string;
  /** 启动命令，如 npx / uvx / node */
  command: string;
  /** 命令参数（原样保存，由运行时自行拆分） */
  args: string;
  /** 环境变量，每行 KEY=VALUE */
  env: string;
  enabled: boolean;
}

/** 数字员工启用的技能 */
export interface EmployeeSkill {
  id: string;
  name: string;
  /** 技能目录或来源描述 */
  source: string;
  enabled: boolean;
}

/** 数字员工的可编辑字段；新建与更新共用 */
export interface DigitalEmployeeDraft {
  name: string;
  /** 职位 / 角色，如「产品分析」 */
  role: string;
  description: string;
  /** 头像 data URL；null 表示未设置 */
  avatar: string | null;
  /** 绑定的 Agent（AgentManifest.id） */
  agentId: string;
  /** 模型名；留空由 Agent 自己决定 */
  model: string;
  systemPrompt: string;
  mcpServers: EmployeeMcpServer[];
  skills: EmployeeSkill[];
  enabled: boolean;
}

/** 持久化后的数字员工 */
export interface DigitalEmployee extends DigitalEmployeeDraft {
  id: string;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// 工作流
// ============================================================================

/** 画布节点类型：开始 / 结束 / 数字员工执行节点 */
export type WorkflowNodeType = "start" | "end" | "employee";

/**
 * 节点失败策略：
 * - stop  失败停止：该节点失败后立即终止整个工作流
 * - skip  自动跳过：标记为跳过，继续执行下游节点（下游拿到空输出）
 * - retry 自动重试：按 maxRetries 重试，仍失败则终止整个工作流
 *
 * 人工审核被驳回时同样视为「节点失败」，由本策略决定后续走向。
 */
export type WorkflowFailureStrategy = "stop" | "skip" | "retry";

/**
 * 审核门禁：
 * - auto   自动通过：节点直接执行
 * - manual 人工审核：执行前暂停，等待人工通过 / 驳回
 *
 * 门禁作用于「执行前」：通过后才把任务详情交给数字员工。
 */
export type WorkflowReviewMode = "auto" | "manual";

export interface WorkflowNodeConfig {
  /** 绑定的数字员工 id；仅 employee 节点使用，未配置时为 null */
  employeeId: string | null;
  /** 任务详情：节点执行时交给数字员工的完整指令 */
  taskDetail: string;
  failureStrategy: WorkflowFailureStrategy;
  /** 自动重试次数（不含首次执行），仅在 retry 策略下生效，范围 1-5 */
  maxRetries: number;
  reviewMode: WorkflowReviewMode;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  name: string;
  position: { x: number; y: number };
  config: WorkflowNodeConfig;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** 可编辑字段；新建与更新共用 */
export interface WorkflowDraft {
  name: string;
  description: string;
  graph: WorkflowGraph;
}

/** 持久化后的工作流 */
export interface Workflow extends WorkflowDraft {
  id: string;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// 设置
// ============================================================================

export interface AppSettings {
  /** 默认 Agent 的 manifest id；空字符串表示"未指定，取第一个已安装的" */
  defaultAgent: string;
  defaultCwd: string;
  /** 皮肤 id，取值来自皮肤注册表（不做联合类型硬编码，新增皮肤无需改本文件） */
  theme: string;
  /** 界面基准字号（px） */
  fontSize: number;
  /** 聊天记录区域的独立字号（px）；与全局字号解耦，便于单独调大 */
  chatFontSize: number;
  /** 文件预览区域的独立字号（px） */
  previewFontSize: number;
  /** 自动化看板同时执行的任务数上限 */
  automationConcurrency: number;
  /** 自动化看板扫描待执行任务的间隔（秒） */
  automationPollIntervalSec: number;
  /** 单次运行超时（分钟）：超过后中断并记为失败 */
  agentTimeoutMinutes: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultAgent: "",
  defaultCwd: "",
  theme: "",
  fontSize: 13,
  chatFontSize: 13,
  previewFontSize: 14,
  automationConcurrency: 3,
  automationPollIntervalSec: 30,
  agentTimeoutMinutes: 30,
};
