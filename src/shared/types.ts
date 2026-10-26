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
 * 宿主内部注入的单次运行参数（工作流系统提示词、MCP 配置等）。
 *
 * 不是用户可配置项：会话与工作流如何运行（模型 / 权限 / 接入）完全由
 * Agent 平台的本机配置决定。key → 命令行开关的映射由 provider 负责。
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

/**
 * 会话可选地绑定一个项目（工作目录）。
 *
 * 项目不再是会话的前置条件：用户可以直接新建会话，需要读写本地文件时
 * 再在输入框处绑定项目。未绑定时会话在默认目录中运行。
 */
export interface Session {
  id: string;
  /** 绑定的项目；null 表示未绑定（使用默认工作目录） */
  projectId: string | null;
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

/**
 * 数字员工绑定的 MCP 服务。
 *
 * 新版只存资产引用；旧版是内联配置（assetId 为空）。内联字段保留是为了
 * 兼容历史数据：运行时仍可直接用 command/args/env 注入，UI 会提示迁移。
 */
export interface EmployeeMcpServer {
  /** Claude MCP 的引用键：通常为 mcpServers 里的服务名 */
  assetId: string;
  /** 展示名 / 服务名 */
  name: string;
  enabled: boolean;
  /** 旧版内联字段，仅用于迁移兼容；新数据不再写入 */
  command?: string;
  /** 旧版参数文本，仅用于迁移兼容 */
  args?: string;
  /** 旧版环境变量，仅用于迁移兼容 */
  env?: string;
}

// ============================================================================
// MCP 资产
// ============================================================================

/** MCP 传输方式 */
export type McpTransport = "stdio" | "http" | "sse";

/**
 * MCP 来源。
 *
 * - claude-global   Claude Code 用户级配置（~/.claude.json 顶层 mcpServers）
 *
 * Nova 不再维护自己的 MCP 库；新增/修改直接写入 Claude 配置。
 * `managedByNova` 标记哪些条目是 Nova 创建的，用于决定是否允许编辑/删除。
 */
export type McpSource = "claude-global";

/**
 * 一个 MCP 服务定义。
 *
 * 与 Skill 不同，MCP 不是「复制目录给 Agent 读」，而是 Nova 在每次运行时
 * 把它渲染成目标 Agent 的配置。因此这里只描述服务本身，与具体 Agent 无关。
 */
export interface McpServerAsset {
  /** 稳定引用 id，格式 `${source}:${slug}` */
  id: string;
  /** 库内文件名（library）/ 服务名（发现型） */
  slug: string;
  /** 服务名，决定 Agent 侧的工具命名空间 */
  name: string;
  description: string;
  transport: McpTransport;
  /** stdio 启动命令 */
  command: string;
  args: string[];
  /** 环境变量；值可以是字面量或 ${VAR} 占位符 */
  env: Record<string, string>;
  /** http / sse 端点 */
  url: string;
  /** http / sse 请求头 */
  headers: Record<string, string>;
  /** 定义文件路径（通常为 ~/.claude.json） */
  path: string;
  source: McpSource;
  /** 是否由 Nova 创建。Claude 原有的条目只读，Nova 创建的条目可编辑/删除 */
  managedByNova: boolean;
  readOnly: boolean;
  readOnlyReason: string | null;
  /** env / headers 中是否包含字面量密钥（非 ${...} 占位符） */
  hasSecrets: boolean;
  valid: boolean;
  problems: string[];
  updatedAt: number;
}

/** MCP 编辑表单：多值字段用文本编辑，保存时再结构化 */
export interface McpServerDraft {
  name: string;
  description: string;
  transport: McpTransport;
  command: string;
  /** 每行一个参数 */
  args: string;
  /** 每行 KEY=VALUE；值支持 ${VAR} 占位符 */
  env: string;
  url: string;
  /** 每行 KEY=VALUE */
  headers: string;
}

export interface McpImportResult {
  ok: boolean;
  imported: McpServerAsset[];
  error?: string;
}

export type McpWriteResult =
  | { ok: true; asset: McpServerAsset }
  | { ok: false; error: string };

// ============================================================================
// 知识库资产
// ============================================================================

/**
 * 知识库 = ~/.novastudio/knowledge/<slug>/ 下的一个 Markdown 文档目录。
 *
 * 与 Skill / MCP 相同，磁盘目录是唯一事实来源；元信息存目录内的 .kb.json。
 * 只收 Markdown：其他格式无法进入索引，也不会被运行时注入。
 */
export interface KnowledgeBaseAsset {
  /** 稳定引用 id，格式 knowledge:<slug> */
  id: string;
  /** 目录名，也是知识库在磁盘上的唯一标识 */
  slug: string;
  /** 展示名（.kb.json 里的 name） */
  name: string;
  description: string;
  /** 知识库根目录的绝对路径 */
  path: string;
  /** Markdown 文档总数（递归统计） */
  documentCount: number;
  /** Markdown 文档总字节数 */
  totalBytes: number;
  updatedAt: number;
}

/** 知识库里的一个条目：Markdown 文档或子文件夹 */
export interface KnowledgeDocument {
  name: string;
  /** 相对知识库根目录的 POSIX 路径 */
  relativePath: string;
  isDirectory: boolean;
  size: number;
  updatedAt: number;
  /** 是否已进入全文索引；超过索引上限的文件为 false */
  indexed: boolean;
}

/** 数字员工绑定的知识库：只存引用，内容由知识库统一管理 */
export interface EmployeeKnowledge {
  /** KnowledgeBaseAsset.id */
  assetId: string;
  /** 展示名快照，资产失效时仍可显示 */
  name: string;
  enabled: boolean;
}

export type KnowledgeWriteResult =
  | { ok: true; asset: KnowledgeBaseAsset }
  | { ok: false; error: string };

export interface KnowledgeUploadResult {
  ok: boolean;
  uploaded: KnowledgeDocument[];
  /** 部分文件被跳过时的提示（非 Markdown / 超大 / 同名改名等） */
  warnings: string[];
  error?: string;
}

/** 全文检索命中的一条文档 */
export interface KnowledgeSearchHit {
  kbId: string;
  kbName: string;
  relativePath: string;
  /** 命中片段；\u0001 / \u0002 包裹高亮文字，由渲染层转换 */
  snippet: string;
}

export interface KnowledgeSearchResult {
  hits: KnowledgeSearchHit[];
  total: number;
  query: string;
  /** 查询词过短（<3 字符），已降级为 LIKE 扫描 */
  degraded: boolean;
}

/** 知识库文档正文（供预览抽屉使用） */
export interface KnowledgeDocumentContent {
  content: string;
  size: number;
  updatedAt: number;
  /** 超过预览上限被截断 */
  truncated: boolean;
}

// ============================================================================
// 技能资产
// ============================================================================

/**
 * Skill 来源。
 *
 * - claude-global   Claude Code 全局技能目录 ~/.claude/skills（Nova 可写）
 * - agents-store    ~/.agents/skills（其他工具维护，只读）
 *
 * Nova 不再维护自己的技能主库。
 */
export type SkillOrigin = "claude-global" | "agents-store";

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
  /** 是否由 Nova 创建。Claude 原有的技能只读，Nova 创建的技能可编辑/删除 */
  managedByNova: boolean;
  /** 是否只读 */
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
  /** Claude Skill 的引用键：通常为 ~/.claude/skills 下的目录名 */
  assetId: string;
  /** 展示名快照，资产失效时仍可显示 */
  name: string;
  /** 旧版路径来源，仅用于迁移兼容 */
  source?: string;
  enabled: boolean;
}

/**
 * 数字员工的可编辑字段；新建与更新共用。
 *
 * 员工不绑定 Agent：执行平台由工作流节点在选择员工时一并指定，
 * 这样同一位员工可以在不同工作流 / 节点里使用不同的 Agent。
 */
export interface DigitalEmployeeDraft {
  name: string;
  /** 职位 / 角色，如「产品分析」 */
  role: string;
  description: string;
  /** 头像 data URL；null 表示未设置 */
  avatar: string | null;
  systemPrompt: string;
  mcpServers: EmployeeMcpServer[];
  skills: EmployeeSkill[];
  knowledgeBases: EmployeeKnowledge[];
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
  /**
   * 执行该节点的 Agent（AgentManifest.id）；仅 employee 节点使用。
   *
   * Agent 属于节点而不是员工：同一位员工可以在不同节点里交给不同的 CLI 执行。
   */
  agentId: string | null;
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
// 工作流触发器
// ============================================================================

/**
 * 定时方式：
 * - daily    每天固定时刻
 * - weekly   每周选定的星期固定时刻
 * - interval 每隔 N 分钟
 *
 * 规则刻意不引入 cron：配置项少、出错了也容易解释。
 * time 为本地时间，格式 HH:mm；weekdays 0=周日 … 6=周六。
 */
export type WorkflowTriggerSchedule =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; weekdays: number[] }
  | { kind: "interval"; minutes: number };

/** 触发器：可在「触发器」页面统一创建，再绑定到任意多个工作流 */
export interface WorkflowTrigger {
  id: string;
  title: string;
  description: string;
  schedule: WorkflowTriggerSchedule;
  enabled: boolean;
  /** 上次触发时间；从未触发为 null */
  lastFiredAt: number | null;
  /** 下次触发时间；停用时为 null */
  nextFireAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 可编辑字段；新建与更新共用 */
export interface WorkflowTriggerDraft {
  title: string;
  description: string;
  schedule: WorkflowTriggerSchedule;
  enabled: boolean;
}

/** 触发器与工作流的绑定关系（多对多） */
export interface WorkflowTriggerBinding {
  triggerId: string;
  workflowId: string;
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
  /** 产物根目录（工作区下 .novastudio/workflows/<workflowId>/<run>） */
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
 *
 * 每个节点只保留两份文本：提交给 Agent 的完整请求、Agent 的最终返回。
 * 文本按需从产物目录读取；mcp.json 含环境变量，不对外暴露。
 */
export interface WorkflowNodeRunDetail {
  /** 提交给 Agent 的完整请求（系统提示词 + 任务输入） */
  request: string;
  /** Agent 最终返回 */
  result: string;
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
