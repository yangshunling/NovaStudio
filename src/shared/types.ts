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

/** 会话来源：普通聊天 / 工作流节点执行 */
export type SessionSource = "chat" | "workflow";

/** 会话从属于一个项目 */
export interface Session {
  id: string;
  projectId: string;
  /** 未声明时视为 chat（兼容旧数据） */
  source?: SessionSource;
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
  /**
   * CLI 配置目录（如 Claude 的 CLAUDE_CONFIG_DIR）。
   * 工作流节点会为每次运行使用独立配置目录；普通会话为 null，走用户默认目录。
   */
  configDir?: string | null;
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

// ============================================================================
// 技能资产
// ============================================================================

/**
 * 技能来源。
 *
 * - library         Nova 主库（~/.novastudio/skills/）：可上传、编辑、删除
 * - claude-global   Claude Code 全局目录（~/.claude/skills/）：只读发现
 * - agents-store    共享技能库（~/.agents/skills/）：只读发现
 *
 * 只读来源由各自工具管理，Nova 只做索引与引用，避免两边同时写导致状态漂移。
 */
export type SkillOrigin = "library" | "claude-global" | "agents-store";

/**
 * 一个技能资产 = 磁盘上的一个技能目录（含 SKILL.md）。
 *
 * 技能内容始终以文件为准，本结构只是扫描后的索引视图；
 * 同名技能可以在多个来源同时存在，UI 按来源分别展示。
 */
export interface SkillAsset {
  /** 稳定引用 id，格式 `${origin}:${slug}` */
  id: string;
  /** 目录名，也是技能在本来源内的唯一标识 */
  slug: string;
  /** SKILL.md frontmatter 里的 name；缺失时回退为目录名 */
  name: string;
  description: string;
  origin: SkillOrigin;
  /** 技能目录的绝对路径 */
  path: string;
  /** 是否只读（非 Nova 主库的来源） */
  readOnly: boolean;
  /** 只读原因：UI 直接展示，说明为什么不能删除 / 编辑 */
  readOnlyReason: string | null;
  /** 是否可被 Agent 正常加载（缺 SKILL.md 或 name 非法时为 false） */
  valid: boolean;
  /** 校验提示；空数组表示没有发现问题 */
  problems: string[];
  /** 文件数（最多统计 200 个） */
  fileCount: number;
  /** 是否包含可执行脚本（.sh / .ps1 / .py / .js 等） */
  hasScripts: boolean;
  /** SKILL.md 最近修改时间 */
  updatedAt: number;
}

/** 技能文档：供技能页预览 / 编辑 */
export interface SkillDocument {
  content: string;
  /** 实际文件路径（SKILL.md） */
  path: string;
  readOnly: boolean;
  /** 文件超过读取上限被截断：此时禁止保存，避免用截断内容覆写原文 */
  truncated: boolean;
  asset: SkillAsset;
}

export type SkillImportKind = "directory" | "file";

export interface SkillImportResult {
  ok: boolean;
  imported: SkillAsset[];
  error?: string;
}

export type SkillWriteResult =
  | { ok: true; asset: SkillAsset }
  | { ok: false; error: string };

/** 数字员工绑定的技能：只存引用，技能内容由技能库统一管理 */
export interface EmployeeSkill {
  /** SkillAsset.id；旧版路径技能为空字符串 */
  assetId: string;
  /** 展示名快照，资产失效时仍可显示 */
  name: string;
  /** 旧版路径来源；仅在 assetId 为空时用于兼容运行时 */
  source?: string;
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
  /** 所属工作区（复用项目的 id）：工作流只在某个根目录下存在 */
  workspaceId: string;
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
// 工作流运行
// ============================================================================

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted";

export type WorkflowNodeRunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "retrying"
  | "succeeded"
  | "failed"
  | "skipped"
  | "canceled";

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workspaceId: string;
  workflowName: string;
  workspacePath: string;
  /** 运行时的工作流图快照；运行中改工作流不影响本次执行 */
  graph: WorkflowGraph;
  /** 产物根目录（工作区下 .novastudio/workflows/<workflowId>/runs/<runId>） */
  artifactDir: string;
  status: WorkflowRunStatus;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WorkflowNodeRun {
  id: string;
  runId: string;
  nodeId: string;
  nodeName: string;
  nodeType: WorkflowNodeType;
  employeeId: string | null;
  employeeName: string | null;
  agentId: string | null;
  status: WorkflowNodeRunStatus;
  /** 当前（或最后一次）尝试序号，从 1 开始 */
  attempt: number;
  maxRetries: number;
  sessionId: string | null;
  artifactDir: string | null;
  inputPath: string | null;
  outputPath: string | null;
  handoffPath: string | null;
  outputSummary: string | null;
  error: string | null;
  decision: "approved" | "rejected" | null;
  decidedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export type WorkflowRunEventType =
  | "run_started"
  | "node_status"
  | "node_retry"
  | "approval_required"
  | "approval_decided"
  | "node_finished"
  | "run_finished"
  | "log";

export interface WorkflowRunEvent {
  seq: number;
  runId: string;
  nodeRunId: string | null;
  type: WorkflowRunEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

/** 运行详情一次性返回：run + 节点状态 + 事件（用于打开页面时回放） */
export interface WorkflowRunDetail {
  run: WorkflowRun;
  nodes: WorkflowNodeRun[];
  events: WorkflowRunEvent[];
}

/** 节点产物目录里的单个文件 */
export interface WorkflowArtifactFile {
  name: string;
  relativePath: string;
  size: number;
}

/**
 * 单个节点的执行详情。
 * 文本内容来自产物目录，按需读取；mcp.json 含环境变量，不对外暴露。
 */
export interface WorkflowNodeRunDetail {
  /** 实际拼装后交给 Agent 的任务输入 */
  input: string;
  /** 员工人设 / 系统提示词 */
  systemPrompt: string;
  /** Agent 最终返回 */
  output: string;
  /** 结构化交接单 */
  handoff: string;
  /** 本次调用的运行参数（模型 / MCP 是否隔离等） */
  options: string;
  /** 隔离环境告警 */
  warnings: string;
  files: WorkflowArtifactFile[];
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
  automationConcurrency: 3,
  automationPollIntervalSec: 30,
  agentTimeoutMinutes: 30,
};
