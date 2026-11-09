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

/** 工具返回的图片。data 是不带 data: 前缀的 base64 原文 */
export interface ToolResultImage {
  /** MIME 类型，如 image/png */
  mediaType: string;
  data: string;
}

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
      /**
       * 变更在文件中的起始行号（1-based），与 input 里的多段替换一一对应。
       * provider 能定位时给出；拿不到则缺省 —— 展示层据此决定是否显示行号，
       * 而不是从 1 开始假装知道位置。
       */
      lineStarts?: number[];
    }
  | {
      type: "tool_result";
      /** 对应 tool_call.callId */
      callId?: string;
      name: string;
      output: string;
      isError?: boolean;
      /** 工具返回的图片（截图等）；文本输出仍在 output 里 */
      images?: ToolResultImage[];
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

/** Markdown 内嵌图片：按所在文档目录解析后转成 data URL，供渲染进程展示 */
export type ReadEmbeddedImageResult =
  | { ok: true; dataUrl: string; mimeType: string }
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
  /** 配置文件里 `mcpServers[name]` 的原始对象，详情页直接展示 / 编辑 */
  definition: Record<string, unknown>;
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
 * 知识库 = ~/.novastudio/knowledge/<slug>/ 下的一个资料目录。
 *
 * 与 Skill / MCP 相同，磁盘目录是唯一事实来源；元信息存目录内的 .kb.json。
 * 接受任意格式文件：文本类文件进入全文索引，二进制文件仅存储并供 Agent 读取。
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
  /** 文件总数（递归统计，含非文本格式） */
  documentCount: number;
  /** 文件总字节数 */
  totalBytes: number;
  updatedAt: number;
}

/** 知识库里的一个条目：文件或子文件夹 */
export interface KnowledgeDocument {
  name: string;
  /** 相对知识库根目录的 POSIX 路径 */
  relativePath: string;
  isDirectory: boolean;
  size: number;
  updatedAt: number;
  /** 是否已进入全文索引；非文本格式或超过索引上限的文件为 false */
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
  /** 部分文件被跳过或未索引时的提示（超大 / 同名改名 / 非文本格式等） */
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

/** 保存知识库文本文件的结果 */
export type KnowledgeDocumentWriteResult =
  | { ok: true; document: KnowledgeDocumentContent }
  | { ok: false; error: string };

// ============================================================================
// 技能资产
// ============================================================================

/**
 * Skill 来源。
 *
 * - claude-global   Claude Code 全局技能目录 ~/.claude/skills
 *
 * Nova 不再维护自己的技能主库。
 */
export type SkillOrigin = "claude-global";

/**
 * 一个技能资产 = 磁盘上的一个技能目录（含 SKILL.md）。
 *
 * 技能内容始终以文件为准，本结构只是扫描后的索引视图。
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

/** 技能目录下的文件内容：供技能页按文件预览 / 编辑 */
export interface SkillFileDocument {
  /** 相对技能目录的路径，统一使用 `/` 分隔 */
  relativePath: string;
  /** 实际文件路径 */
  path: string;
  content: string;
  /** 文件超过读取上限被截断：此时禁止保存，避免用截断内容覆写原文 */
  truncated: boolean;
  /** 二进制文件：不在 Nova 中展示内容，也不允许保存 */
  binary: boolean;
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
 * 节点失败策略（仅作用于「执行失败」）：
 * - stop  失败停止：该节点失败后立即终止整个工作流
 * - skip  自动跳过：标记为跳过，继续执行下游节点（下游拿到空输出）
 * - retry 自动重试：按 maxRetries 重试，仍失败则终止整个工作流
 *
 * 人工审核驳回不走这里的策略：它意味着产物本身不合格，
 * 一律立即终止整条运行，且该运行不允许续跑。
 */
export type WorkflowFailureStrategy = "stop" | "skip" | "retry";

/**
 * 审核门禁：
 * - auto   自动通过：节点执行完成后直接视为通过
 * - manual 人工审核：节点执行完成后暂停，等人工确认产物
 *
 * 门禁作用于「执行后」：数字员工先跑完，产物落库并展示给审核人。
 * 通过则节点完成并继续下游；
 * 「要求修改」会在同一个会话里带着评审意见继续执行，受 maxRevisions 限制；
 * 驳回立即终止整条运行且不能重试。
 * 等待超时（默认 30 分钟）按「中断」处理，保留产物，运行可续跑。
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
  /**
   * 人工审核最多允许「要求修改」的轮数。
   * 0 表示不允许修改；范围 0-3。仅 reviewMode=manual 时生效。
   */
  maxRevisions: number;
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
  /** 最近一次启动失败的原因；成功启动后清空 */
  lastError: string | null;
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
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted";

/** 运行来源：手动触发 / 定时触发器 */
export type WorkflowRunSource = "manual" | "trigger";

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
  /** 手动运行 / 触发器运行 */
  source: WorkflowRunSource;
  /** 触发器运行对应的触发器 id；手动运行为 null */
  triggerId: string | null;
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
  /** 当前（或最后一次）尝试内的修正轮次，从 1 开始 */
  round: number;
  maxRetries: number;
  sessionId: string | null;
  artifactDir: string | null;
  inputPath: string | null;
  outputPath: string | null;
  outputSummary: string | null;
  error: string | null;
  decision: "approved" | "rejected" | null;
  /** 审核备注：通过可以留空，驳回建议填写原因，供下游与历史查看 */
  decisionNote: string | null;
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

/**
 * 运行详情：run + 节点状态。
 *
 * 事件日志不在详情里返回：实时更新由 workflow:run:event 推送驱动，
 * 页面只需要 run / nodes，携带全量事件会让长运行的每次刷新都变成全表读取。
 */
export interface WorkflowRunDetail {
  run: WorkflowRun;
  nodes: WorkflowNodeRun[];
}

/** 节点产物目录里的单个文件 */
export interface WorkflowArtifactFile {
  name: string;
  relativePath: string;
  size: number;
}

/** 一次节点调用的来源：初次执行 / 执行失败重试 / 人工要求修改 */
export type WorkflowNodeAttemptKind = "initial" | "retry" | "revise";

/**
 * 单次尝试的完整对话（user 指令 + assistant 的思考 / 工具调用 / 文本）。
 *
 * 人工要求修改会复用同一个 Nova 会话，因此同一 attempt 下可能有多个 round；
 * messages 只包含本轮产生的消息，避免把整条会话重复展示。
 */
export interface WorkflowNodeAttemptDetail {
  /** 执行尝试序号，从 1 开始 */
  attempt: number;
  /** 该尝试内的轮次，从 1 开始；round > 1 表示人工要求修改 */
  round: number;
  kind: WorkflowNodeAttemptKind;
  sessionId: string | null;
  messages: Message[];
}

/**
 * 运行中节点的实时事件快照。
 *
 * 主进程在节点执行期间保留原始事件（不落库），供运行记录中途打开时回放；
 * 后续事件通过 `workflow:run:agentEvent` 推送，按 seq 合并。
 */
export interface WorkflowNodeLiveTranscript {
  /** 执行尝试序号，从 1 开始 */
  attempt: number;
  /** 该尝试内的轮次，从 1 开始 */
  round: number;
  /** 已产生的事件数；events[seq - 1] 对应该序号 */
  seq: number;
  events: AgentEvent[];
}

/**
 * 单个节点的执行详情。
 *
 * execution / result 是落盘的两份文本；attempts 是每次尝试的完整对话，
 * 用于在运行记录里还原 Claude 的完整执行链路。
 * mcp.json 含环境变量，不对外暴露。
 */
/** 节点运行过程中值得展示的告警 / 重试 / 审批事件 */
export interface WorkflowNodeNotice {
  type: string;
  /** info / warning / error */
  level: string;
  message: string;
  createdAt: number;
}

export interface WorkflowNodeRunDetail {
  /** 本次执行的完整现场（Agent 配置 / 注入能力 / 命令行 / 提示词 / 结果） */
  execution: string;
  /** Agent 最终返回 */
  result: string;
  /** 告警 / 重试 / 审批等运行提示 */
  notices: WorkflowNodeNotice[];
  files: WorkflowArtifactFile[];
  /** 按尝试顺序排列的对话；旧记录或尚未开始执行时为空 */
  attempts: WorkflowNodeAttemptDetail[];
  /** 节点正在执行时的实时事件快照；不在运行时为 null */
  live: WorkflowNodeLiveTranscript | null;
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
  /** 终端字号（px）；终端字体固定使用系统等宽字体 */
  terminalFontSize: number;
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
  terminalFontSize: 15,
  automationConcurrency: 3,
  automationPollIntervalSec: 30,
  agentTimeoutMinutes: 30,
};

// ============================================================================
// 应用更新
// ============================================================================

/**
 * 更新流程所处阶段。
 *
 * 主进程是唯一状态源：electron-updater 的事件在这里归一成状态快照，
 * 再通过 `updater:changed` 推送；渲染进程只负责展示与触发动作。
 */
export type UpdaterPhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

/** 一次更新流程的状态快照 */
export interface UpdaterState {
  phase: UpdaterPhase;
  /** 当前运行的应用版本 */
  currentVersion: string;
  /** 可更新到的新版本；没有新版时为 null */
  version: string | null;
  /** 下载进度 0-100；未进入下载阶段时为 0 */
  percent: number;
  /** 说明或错误信息；正常情况下为 null */
  message: string | null;
  /**
   * 当前环境是否支持应用内更新。
   * 开发模式（未打包）下 electron-updater 不可用，为 false。
   */
  supported: boolean;
}

// ============================================================================
// 待办事项
// ============================================================================

/** 优先级：只做三档，避免把个人清单做成任务系统 */
export type TodoPriority = "low" | "normal" | "high";

/** 一条个人待办 */
export interface TodoItem {
  id: string;
  title: string;
  /** 备注，可为空；列表里只展示一行摘要 */
  note: string;
  priority: TodoPriority;
  /** 截止日期（本地时间当天 0 点）；无截止日期为 null */
  dueAt: number | null;
  /** 自定义标签，去重后保存 */
  tags: string[];
  done: boolean;
  completedAt: number | null;
  /** 手动排序值；越小越靠前 */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** 可编辑字段；新建与更新共用 */
export interface TodoDraft {
  title: string;
  note: string;
  priority: TodoPriority;
  dueAt: number | null;
  tags: string[];
}

// ============================================================================
// 提示词
// ============================================================================

/**
 * 一条常用提示词。
 *
 * 与应用内其它实体完全独立：只做「收藏 → 查找 → 复用」这条链路，
 * 后续需要接到会话输入框时再按 id 取正文即可。
 */
export interface PromptItem {
  id: string;
  title: string;
  content: string;
  /** 自定义标签，用于筛选 */
  tags: string[];
  /** 收藏的提示词排在列表最前面 */
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 可编辑字段；新建与更新共用 */
export interface PromptDraft {
  title: string;
  content: string;
  tags: string[];
  favorite: boolean;
}

/** 应用与运行环境信息，供「关于」页展示 */
export interface AppInfo {
  /** 应用名（package.json 的 name） */
  name: string;
  /** 应用版本 */
  version: string;
  /** Electron 运行时版本 */
  electron: string;
  /** Chromium 版本 */
  chrome: string;
  /** Node.js 版本 */
  node: string;
  /** 运行平台：win32 / darwin / linux */
  platform: string;
  /** CPU 架构：x64 / arm64 等 */
  arch: string;
  /** 是否为打包后的正式环境 */
  packaged: boolean;
}
