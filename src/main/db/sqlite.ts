/**
 * SQLite 持久化
 *
 * 使用 better-sqlite3 同步 API（N-API，ABI 稳定，Electron 下无需 rebuild）。
 *
 * 数据模型：
 * - projects：一个项目 = 一个工作文件夹 + 名字
 * - sessions：从属于项目，继承项目 cwd。只存索引（标题/时间/消息计数/CLI 会话引用），
 *   正文不入库——由对应 Agent 的 provider 从 CLI 侧回放。
 * - messages：存储会话的完整事件流（AgentEvent[] 的 JSON 序列化），
 *   供应用重启后回放完整对话过程（含工具调用、思考等），不再依赖 CLI 侧回放。
 * - settings：键值对
 *
 * schema 变更走"加列 + 迁移"策略：检测到旧表缺列就 ALTER，
 * 孤儿会话（无 project_id）归入自动创建的"收件箱"项目。
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type {
  Project,
  Session,
  Message,
  AutomationTask,
  AutomationStatus,
  DigitalEmployee,
  DigitalEmployeeDraft,
  SessionSource,
  Workflow,
  WorkflowDraft,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowNodeRunStatus,
  WorkflowRun,
  WorkflowRunEvent,
  WorkflowRunEventType,
  WorkflowRunStatus,
} from "../../shared/types";
import { DB_PATH, ensureDataDirs } from "../utils/paths";

let db: Database.Database | null = null;

/** 收件箱项目名：迁移孤儿会话时用 */
const INBOX_PROJECT_NAME = "收件箱";

/** 初始化数据库连接和表结构 */
export function initDatabase(): void {
  ensureDataDirs();
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      agent_id TEXT NOT NULL,
      agent_session_id TEXT,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      config_dir TEXT,
      source TEXT NOT NULL DEFAULT 'chat',
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      session_id TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      graph_json TEXT NOT NULL,
      artifact_dir TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS workflow_node_runs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_name TEXT NOT NULL,
      node_type TEXT NOT NULL,
      employee_id TEXT,
      employee_name TEXT,
      agent_id TEXT,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      max_retries INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      artifact_dir TEXT,
      input_path TEXT,
      output_path TEXT,
      handoff_path TEXT,
      output_summary TEXT,
      error TEXT,
      decision TEXT,
      decided_at INTEGER,
      started_at INTEGER,
      finished_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS workflow_run_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      node_run_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_node_attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      session_id TEXT,
      artifact_dir TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_run
      ON workflow_node_runs (run_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_node_attempts_run
      ON workflow_node_attempts (run_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_run_events_run
      ON workflow_run_events (run_id, seq);

    CREATE TABLE IF NOT EXISTS digital_employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      avatar TEXT,
      agent_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      mcp_servers_json TEXT NOT NULL DEFAULT '[]',
      skills_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // === schema 迁移：只服务旧库 ===
  // 上面的 CREATE TABLE 已包含全部列，新装用户不会走到这里；
  // 旧库因表已存在而跳过 CREATE，故需要 ALTER 补齐后加的列。
  migrateSessionsProjectId();
  migrateSessionsMessageCount();
  migrateSessionsConfigDir();
  migrateSessionsSource();
  migrateWorkflowWorkspace();

  // === 数据迁移：孤儿会话归入"收件箱"项目 ===
  migrateOrphanSessions();

  // 上次进程遗留的运行不可能还活着：统一标记为中断
  interruptStaleWorkflowRuns();
}

/** 检测并给 sessions 表补 project_id 列 */
function migrateSessionsProjectId(): void {
  const cols = db!.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "project_id")) {
    db!.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT");
  }
}

/** 检测并给 sessions 表补 source 列：工作流节点会话不进入项目会话列表 */
function migrateSessionsSource(): void {
  const cols = db!.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "source")) {
    db!.exec("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'chat'");
  }

  // 历史工作流节点已经建过会话：按 node_runs.session_id 回填来源，
  // 避免旧数据继续出现在项目会话树里。该 UPDATE 可重复执行。
  db!.exec(`
    UPDATE sessions
    SET source = 'workflow'
    WHERE COALESCE(source, 'chat') <> 'workflow'
      AND id IN (
        SELECT session_id FROM workflow_node_runs WHERE session_id IS NOT NULL
      )
  `);
}

/** 检测并给 sessions 表补 config_dir 列（工作流节点使用独立 CLI 配置目录） */
function migrateSessionsConfigDir(): void {
  const cols = db!.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "config_dir")) {
    db!.exec("ALTER TABLE sessions ADD COLUMN config_dir TEXT");
  }
}

/** 检测并给 sessions 表补 message_count 列（旧索引不含消息计数） */
function migrateSessionsMessageCount(): void {
  const cols = db!.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "message_count")) {
    db!.exec("ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * 工作区迁移：给旧库补 workspace_id，并把未归属的工作流挂到最早创建的项目上。
 *
 * 工作区复用项目（同一个根目录 + 名字），因此这里不做新的实体，
 * 只保证历史工作流不会因为缺少 workspace_id 而从列表里消失。
 */
function migrateWorkflowWorkspace(): void {
  const cols = db!.prepare("PRAGMA table_info(workflows)").all() as {
    name: string;
  }[];
  if (!cols.some((col) => col.name === "workspace_id")) {
    db!.exec("ALTER TABLE workflows ADD COLUMN workspace_id TEXT");
  }

  const first = db!
    .prepare("SELECT id FROM projects ORDER BY created_at ASC LIMIT 1")
    .get() as { id: string } | undefined;
  if (first) {
    db!.prepare(
      "UPDATE workflows SET workspace_id = ? WHERE workspace_id IS NULL OR workspace_id = ''",
    ).run(first.id);
  }
}

/** 把无 project_id 的旧会话归入自动创建的"收件箱"项目 */
function migrateOrphanSessions(): void {
  const orphans = db!
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id IS NULL")
    .get() as { n: number };
  if (orphans.n === 0) return;

  // 找或建"收件箱"项目
  let inbox = db!
    .prepare("SELECT id FROM projects WHERE name = ?")
    .get(INBOX_PROJECT_NAME) as { id: string } | undefined;
  if (!inbox) {
    const id = randomUUID();
    const now = Date.now();
    db!.prepare(
      "INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, INBOX_PROJECT_NAME, "", now, now);
    inbox = { id };
  }
  db!.prepare("UPDATE sessions SET project_id = ? WHERE project_id IS NULL").run(inbox.id);
}

// ============================================================================
// 项目操作
// ============================================================================

export function listProjects(): Project[] {
  const rows = db!.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as any[];
  return rows.map(rowToProject);
}

export function getProject(id: string): Project | null {
  const row = db!.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
  return row ? rowToProject(row) : null;
}

export function createProject(name: string, cwd: string): Project {
  const id = randomUUID();
  const now = Date.now();
  db!.prepare(
    "INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, name, cwd, now, now);
  return { id, name, cwd, createdAt: now, updatedAt: now };
}

/**
 * 删除项目及其下所有会话（sessions/messages 经外键级联删除）。
 * CLI 侧会话文件的清理由 IPC handler 在调用本函数前完成。
 */
export function deleteProject(id: string): void {
  // 删除会话与项目包在同一个事务里，保证原子性（任一失败则整体回滚）
  db!.transaction(() => {
    db!.prepare("DELETE FROM sessions WHERE project_id = ?").run(id);
    db!.prepare("DELETE FROM projects WHERE id = ?").run(id);
  })();
}

function rowToProject(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// 会话操作
// ============================================================================

/** 创建新会话。title 取首条用户消息前缀，cwd 继承项目 */
export function createSession(
  agentId: string,
  projectId: string,
  cwd: string,
  title?: string,
  configDir?: string | null,
  source: SessionSource = "chat",
): Session {
  const id = randomUUID();
  const now = Date.now();
  const resolvedTitle = title || "新会话";

  db!.prepare(
    "INSERT INTO sessions (id, project_id, agent_id, agent_session_id, title, cwd, config_dir, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    projectId,
    agentId,
    null,
    resolvedTitle,
    cwd,
    configDir ?? null,
    source,
    now,
    now,
  );

  return {
    id,
    projectId,
    source,
    agentId,
    agentSessionId: null,
    title: resolvedTitle,
    cwd,
    configDir: configDir ?? null,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    messages: [],
  };
}

/** 更新会话的 agent session 引用（用于多轮 --resume；pi 为会话文件路径） */
export function updateAgentSessionId(sessionId: string, agentSessionId: string): void {
  db!.prepare(
    "UPDATE sessions SET agent_session_id = ?, updated_at = ? WHERE id = ?",
  ).run(agentSessionId, Date.now(), sessionId);
}

/** 更新会话标题 */
export function setSessionTitle(sessionId: string, title: string): void {
  db!.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(
    title,
    Date.now(),
    sessionId,
  );
}

/**
 * 追加一条消息到 messages 表（content_json 存储 AgentEvent[] 的 JSON 序列化）。
 * 一次 run 产生一条 user 消息 + 一条 assistant 消息；多次 run（对话场景）自然追加。
 */
export function saveSessionMessage(sessionId: string, msg: Message): void {
  db!.prepare(
    "INSERT INTO messages (id, session_id, role, content_json, timestamp) VALUES (?, ?, ?, ?, ?)",
  ).run(msg.id, sessionId, msg.role, JSON.stringify(msg.content), msg.timestamp);
}

/** 读取会话的全部持久化消息（按时间正序）。无数据时返回 null，表示回退到 provider 回放。 */
export function readSessionMessages(sessionId: string): Message[] | null {
  const rows = db!
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC")
    .all(sessionId) as any[];
  if (rows.length === 0) return null;
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: JSON.parse(row.content_json),
    timestamp: row.timestamp,
  }));
}

/**
 * 刷新会话索引：更新时间戳、消息计数增量；首条消息时一并写标题。
 * 对话正文不入库（由对应 Agent 的 provider 回放）。
 */
export function touchSession(
  sessionId: string,
  opts?: { title?: string; countDelta?: number },
): void {
  const now = Date.now();
  const delta = opts?.countDelta ?? 0;
  if (opts?.title) {
    db!.prepare(
      "UPDATE sessions SET title = ?, updated_at = ?, message_count = message_count + ? WHERE id = ?",
    ).run(opts.title, now, delta, sessionId);
  } else {
    db!.prepare(
      "UPDATE sessions SET updated_at = ?, message_count = message_count + ? WHERE id = ?",
    ).run(now, delta, sessionId);
  }
}

/** 数据库行 → Session 对象（列表与单查共用；正文不入库，messages 留空由调用方回放填充） */
function rowToSession(row: any): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    source: (row.source ?? "chat") as Session["source"],
    agentId: row.agent_id,
    agentSessionId: row.agent_session_id,
    title: row.title,
    cwd: row.cwd,
    configDir: row.config_dir ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count ?? 0,
    messages: [],
  };
}

/**
 * 获取聊天会话列表（按更新时间倒序）。
 * 工作流节点会话只服务于运行详情，不应出现在项目会话树里。
 */
export function listSessions(): Session[] {
  const rows = db!
    .prepare(
      "SELECT * FROM sessions WHERE COALESCE(source, 'chat') <> 'workflow' ORDER BY updated_at DESC",
    )
    .all() as any[];
  return rows.map(rowToSession);
}

/**
 * 获取会话元数据。正文不入库——由 agent-service 调 provider 回放后填充 messages 字段。
 */
export function getSession(id: string): Session | null {
  const row = db!.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
  return row ? rowToSession(row) : null;
}

/** 列出某项目下所有会话 id（含工作流会话；用于删除项目时的完整清理） */
export function listSessionIdsByProject(projectId: string): string[] {
  const rows = db!
    .prepare("SELECT id FROM sessions WHERE project_id = ?")
    .all(projectId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** 某项目下的聊天会话 id（「清空会话」只处理用户可见的聊天） */
export function listChatSessionIdsByProject(projectId: string): string[] {
  const rows = db!
    .prepare(
      "SELECT id FROM sessions WHERE project_id = ? AND COALESCE(source, 'chat') <> 'workflow'",
    )
    .all(projectId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * 删除会话索引行（messages 经外键级联删除）。
 * CLI 侧会话文件的清理由 IPC handler 调适配器 deleteSessionFile 完成。
 */
export function deleteSession(id: string): void {
  db!.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

// ============================================================================
// 数字员工操作
// ============================================================================

/** JSON 列的安全解析：损坏或形状不对时退回空数组，不阻断读取 */
function parseJsonArray<T>(raw: string): T[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function rowToDigitalEmployee(row: any): DigitalEmployee {
  return {
    id: row.id,
    name: row.name,
    role: row.role ?? "",
    description: row.description ?? "",
    avatar: row.avatar ?? null,
    agentId: row.agent_id,
    model: row.model ?? "",
    systemPrompt: row.system_prompt ?? "",
    mcpServers: parseJsonArray(row.mcp_servers_json),
    skills: parseJsonArray(row.skills_json),
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 草稿字段 → SQL 参数（顺序与建表列一致，新建 / 更新共用） */
function employeeParams(draft: DigitalEmployeeDraft): unknown[] {
  return [
    draft.name,
    draft.role,
    draft.description,
    draft.avatar,
    draft.agentId,
    draft.model,
    draft.systemPrompt,
    JSON.stringify(draft.mcpServers),
    JSON.stringify(draft.skills),
    draft.enabled ? 1 : 0,
  ];
}

export function listDigitalEmployees(): DigitalEmployee[] {
  const rows = db!
    .prepare("SELECT * FROM digital_employees ORDER BY updated_at DESC")
    .all() as any[];
  return rows.map(rowToDigitalEmployee);
}

export function getDigitalEmployee(id: string): DigitalEmployee | null {
  const row = db!.prepare("SELECT * FROM digital_employees WHERE id = ?").get(id) as any;
  return row ? rowToDigitalEmployee(row) : null;
}

export function createDigitalEmployee(draft: DigitalEmployeeDraft): DigitalEmployee {
  const id = randomUUID();
  const now = Date.now();
  db!.prepare(
    `INSERT INTO digital_employees (
      id, name, role, description, avatar, agent_id, model,
      system_prompt, mcp_servers_json, skills_json,
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ...employeeParams(draft), now, now);
  return getDigitalEmployee(id)!;
}

export function updateDigitalEmployee(
  id: string,
  draft: DigitalEmployeeDraft,
): DigitalEmployee | null {
  const info = db!
    .prepare(
      `UPDATE digital_employees SET
        name = ?, role = ?, description = ?, avatar = ?, agent_id = ?, model = ?,
        system_prompt = ?, mcp_servers_json = ?, skills_json = ?,
        enabled = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(...employeeParams(draft), Date.now(), id);
  return info.changes > 0 ? getDigitalEmployee(id) : null;
}

export function deleteDigitalEmployee(id: string): void {
  db!.prepare("DELETE FROM digital_employees WHERE id = ?").run(id);
}

// ============================================================================
// 工作流操作
// ============================================================================

/**
 * 单节点归一化。
 *
 * 除了兜住损坏数据，还负责一次字段迁移：
 * 旧版把任务内容存在 config.prompt，现统一为 config.taskDetail。
 * 新的策略 / 门禁字段缺失时补默认值（失败停止 + 自动通过）。
 */
function normalizeWorkflowNode(raw: any, index: number): WorkflowNode {
  const config = raw?.config ?? {};
  const type: WorkflowNode["type"] =
    raw?.type === "start" || raw?.type === "end" ? raw.type : "employee";
  const failureStrategy: WorkflowNode["config"]["failureStrategy"] =
    config.failureStrategy === "skip" || config.failureStrategy === "retry"
      ? config.failureStrategy
      : "stop";
  const px = Number(raw?.position?.x);
  const py = Number(raw?.position?.y);

  return {
    id: typeof raw?.id === "string" ? raw.id : `n_${index}`,
    type,
    name: typeof raw?.name === "string" ? raw.name : `节点 ${index + 1}`,
    position: {
      x: Number.isFinite(px) ? px : 120 + (index % 3) * 300,
      y: Number.isFinite(py) ? py : 140 + Math.floor(index / 3) * 160,
    },
    config: {
      employeeId:
        typeof config.employeeId === "string" ? config.employeeId : null,
      taskDetail:
        typeof config.taskDetail === "string"
          ? config.taskDetail
          : typeof config.prompt === "string"
            ? config.prompt
            : "",
      failureStrategy,
      maxRetries:
        typeof config.maxRetries === "number" && config.maxRetries > 0
          ? Math.min(5, Math.round(config.maxRetries))
          : 1,
      reviewMode: config.reviewMode === "manual" ? "manual" : "auto",
    },
  };
}

/** graph_json 的安全解析：结构损坏时退回空画布，不阻断列表加载 */
function parseWorkflowGraph(raw: string): WorkflowGraph {
  try {
    const value = JSON.parse(raw);
    const rawNodes = Array.isArray(value?.nodes) ? value.nodes : [];
    const rawEdges = Array.isArray(value?.edges) ? value.edges : [];

    return {
      nodes: rawNodes.map(normalizeWorkflowNode),
      edges: rawEdges
        .filter(
          (edge: any) =>
            typeof edge?.source === "string" &&
            typeof edge?.target === "string",
        )
        .map((edge: any, index: number) => ({
          id: typeof edge.id === "string" ? edge.id : `e_${index}`,
          source: edge.source,
          target: edge.target,
        })),
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

function rowToWorkflow(row: any): Workflow {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? "",
    name: row.name,
    description: row.description ?? "",
    graph: parseWorkflowGraph(row.graph_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWorkflows(): Workflow[] {
  const rows = db!
    .prepare("SELECT * FROM workflows ORDER BY updated_at DESC")
    .all() as any[];
  return rows.map(rowToWorkflow);
}

export function getWorkflow(id: string): Workflow | null {
  const row = db!.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as any;
  return row ? rowToWorkflow(row) : null;
}

export function createWorkflow(draft: WorkflowDraft): Workflow {
  const id = randomUUID();
  const now = Date.now();
  db!.prepare(
    "INSERT INTO workflows (id, workspace_id, name, description, graph_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    draft.workspaceId,
    draft.name,
    draft.description,
    JSON.stringify(draft.graph),
    now,
    now,
  );
  return getWorkflow(id)!;
}

export function updateWorkflow(id: string, draft: WorkflowDraft): Workflow | null {
  const info = db!
    .prepare(
      "UPDATE workflows SET workspace_id = ?, name = ?, description = ?, graph_json = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      draft.workspaceId,
      draft.name,
      draft.description,
      JSON.stringify(draft.graph),
      Date.now(),
      id,
    );
  return info.changes > 0 ? getWorkflow(id) : null;
}

export function listWorkflowsByWorkspace(workspaceId: string): Workflow[] {
  const rows = db!
    .prepare(
      "SELECT * FROM workflows WHERE workspace_id = ? ORDER BY updated_at DESC",
    )
    .all(workspaceId) as any[];
  return rows.map(rowToWorkflow);
}

export function deleteWorkflow(id: string): void {
  db!.prepare("DELETE FROM workflows WHERE id = ?").run(id);
}

/**
 * 删除某工作流的所有运行记录，并返回需要一并清理的目录与会话。
 *
 * 事件 / 节点运行 / 运行主记录在一个事务里删除；
 * 会话与磁盘目录由调用方清理（需要 provider 与文件系统参与）。
 */
export function deleteWorkflowRuns(workflowId: string): {
  runIds: string[];
  sessionIds: string[];
} {
  const runRows = db!
    .prepare("SELECT id FROM workflow_runs WHERE workflow_id = ?")
    .all(workflowId) as { id: string }[];
  const runIds = runRows.map((row) => row.id);
  const sessionIds = new Set<string>();

  db!.transaction(() => {
    for (const runId of runIds) {
      const nodeRows = db!
        .prepare("SELECT session_id FROM workflow_node_runs WHERE run_id = ?")
        .all(runId) as { session_id: string | null }[];
      const attemptRows = db!
        .prepare("SELECT session_id FROM workflow_node_attempts WHERE run_id = ?")
        .all(runId) as { session_id: string | null }[];
      for (const row of [...nodeRows, ...attemptRows]) {
        if (row.session_id) sessionIds.add(row.session_id);
      }
      db!.prepare("DELETE FROM workflow_run_events WHERE run_id = ?").run(runId);
      db!.prepare("DELETE FROM workflow_node_attempts WHERE run_id = ?").run(runId);
      db!.prepare("DELETE FROM workflow_node_runs WHERE run_id = ?").run(runId);
      db!.prepare("DELETE FROM workflow_runs WHERE id = ?").run(runId);
    }
  })();

  return { runIds, sessionIds: [...sessionIds] };
}

// ============================================================================
// 工作流运行
// ============================================================================

function rowToWorkflowRun(row: any): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workspaceId: row.workspace_id,
    workflowName: row.workflow_name,
    workspacePath: row.workspace_path,
    graph: parseWorkflowGraph(row.graph_json),
    artifactDir: row.artifact_dir,
    status: row.status as WorkflowRunStatus,
    error: row.error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

function rowToWorkflowNodeRun(row: any): WorkflowNodeRun {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    nodeName: row.node_name,
    nodeType: row.node_type,
    employeeId: row.employee_id ?? null,
    employeeName: row.employee_name ?? null,
    agentId: row.agent_id ?? null,
    status: row.status as WorkflowNodeRunStatus,
    attempt: row.attempt ?? 1,
    maxRetries: row.max_retries ?? 0,
    sessionId: row.session_id ?? null,
    artifactDir: row.artifact_dir ?? null,
    inputPath: row.input_path ?? null,
    outputPath: row.output_path ?? null,
    handoffPath: row.handoff_path ?? null,
    outputSummary: row.output_summary ?? null,
    error: row.error ?? null,
    decision: row.decision ?? null,
    decidedAt: row.decided_at ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

function rowToWorkflowRunEvent(row: any): WorkflowRunEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    // 损坏事件不阻断回放
  }
  return {
    seq: row.seq,
    runId: row.run_id,
    nodeRunId: row.node_run_id ?? null,
    type: row.type as WorkflowRunEventType,
    payload,
    createdAt: row.created_at,
  };
}

export function createWorkflowRun(input: {
  id: string;
  workflowId: string;
  workspaceId: string;
  workflowName: string;
  workspacePath: string;
  graph: WorkflowGraph;
  artifactDir: string;
  status: WorkflowRunStatus;
  createdAt: number;
}): WorkflowRun {
  db!.prepare(
    `INSERT INTO workflow_runs (
      id, workflow_id, workspace_id, workflow_name, workspace_path,
      graph_json, artifact_dir, status, error, created_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
  ).run(
    input.id,
    input.workflowId,
    input.workspaceId,
    input.workflowName,
    input.workspacePath,
    JSON.stringify(input.graph),
    input.artifactDir,
    input.status,
    input.createdAt,
  );
  return getWorkflowRun(input.id)!;
}

export function getWorkflowRun(id: string): WorkflowRun | null {
  const row = db!
    .prepare("SELECT * FROM workflow_runs WHERE id = ?")
    .get(id) as any;
  return row ? rowToWorkflowRun(row) : null;
}

export function listWorkflowRuns(workflowId?: string): WorkflowRun[] {
  const rows = workflowId
    ? (db!
        .prepare(
          "SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC",
        )
        .all(workflowId) as any[])
    : (db!
        .prepare("SELECT * FROM workflow_runs ORDER BY created_at DESC")
        .all() as any[]);
  return rows.map(rowToWorkflowRun);
}

export function listWorkflowRunsByWorkspace(
  workspaceId: string,
): WorkflowRun[] {
  const rows = db!
    .prepare(
      "SELECT * FROM workflow_runs WHERE workspace_id = ? ORDER BY created_at DESC",
    )
    .all(workspaceId) as any[];
  return rows.map(rowToWorkflowRun);
}

export function updateWorkflowRun(
  id: string,
  patch: {
    status?: WorkflowRunStatus;
    error?: string | null;
    startedAt?: number | null;
    finishedAt?: number | null;
  },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(patch.status);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    values.push(patch.error);
  }
  if (patch.startedAt !== undefined) {
    sets.push("started_at = ?");
    values.push(patch.startedAt);
  }
  if (patch.finishedAt !== undefined) {
    sets.push("finished_at = ?");
    values.push(patch.finishedAt);
  }
  if (sets.length === 0) return;
  values.push(id);
  db!.prepare(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`).run(
    ...values,
  );
}

export function createWorkflowNodeRun(input: {
  id: string;
  runId: string;
  nodeId: string;
  nodeName: string;
  nodeType: WorkflowNode["type"];
  employeeId: string | null;
  employeeName: string | null;
  agentId: string | null;
  status: WorkflowNodeRunStatus;
  attempt: number;
  maxRetries: number;
}): WorkflowNodeRun {
  db!.prepare(
    `INSERT INTO workflow_node_runs (
      id, run_id, node_id, node_name, node_type, employee_id, employee_name,
      agent_id, status, attempt, max_retries
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.runId,
    input.nodeId,
    input.nodeName,
    input.nodeType,
    input.employeeId,
    input.employeeName,
    input.agentId,
    input.status,
    input.attempt,
    input.maxRetries,
  );
  return getWorkflowNodeRun(input.id)!;
}

/**
 * 记录一次节点尝试的会话与产物目录。
 * workflow_node_runs.session_id 只保存最新一次，重试前的会话靠这张表保留引用，
 * 删除工作流时才能把历次会话全部清理掉。
 */
export function createWorkflowNodeAttempt(input: {
  id: string;
  runId: string;
  nodeRunId: string;
  attempt: number;
  sessionId: string | null;
  artifactDir: string | null;
}): void {
  db!.prepare(
    `INSERT INTO workflow_node_attempts (
      id, run_id, node_run_id, attempt, session_id, artifact_dir, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.runId,
    input.nodeRunId,
    input.attempt,
    input.sessionId,
    input.artifactDir,
    Date.now(),
  );
}

export function getWorkflowNodeRun(id: string): WorkflowNodeRun | null {
  const row = db!
    .prepare("SELECT * FROM workflow_node_runs WHERE id = ?")
    .get(id) as any;
  return row ? rowToWorkflowNodeRun(row) : null;
}

export function listWorkflowNodeRuns(runId: string): WorkflowNodeRun[] {
  const rows = db!
    .prepare(
      "SELECT * FROM workflow_node_runs WHERE run_id = ? ORDER BY rowid ASC",
    )
    .all(runId) as any[];
  return rows.map(rowToWorkflowNodeRun);
}

const NODE_RUN_COLUMNS: Record<string, string> = {
  status: "status",
  attempt: "attempt",
  sessionId: "session_id",
  artifactDir: "artifact_dir",
  inputPath: "input_path",
  outputPath: "output_path",
  handoffPath: "handoff_path",
  outputSummary: "output_summary",
  error: "error",
  decision: "decision",
  decidedAt: "decided_at",
  startedAt: "started_at",
  finishedAt: "finished_at",
};

export function updateWorkflowNodeRun(
  id: string,
  patch: Partial<
    Pick<
      WorkflowNodeRun,
      | "status"
      | "attempt"
      | "sessionId"
      | "artifactDir"
      | "inputPath"
      | "outputPath"
      | "handoffPath"
      | "outputSummary"
      | "error"
      | "decision"
      | "decidedAt"
      | "startedAt"
      | "finishedAt"
    >
  >,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(NODE_RUN_COLUMNS)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (sets.length === 0) return;
  values.push(id);
  db!.prepare(
    `UPDATE workflow_node_runs SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...values);
}

export function appendWorkflowRunEvent(input: {
  runId: string;
  nodeRunId: string | null;
  type: WorkflowRunEventType;
  payload: Record<string, unknown>;
}): WorkflowRunEvent {
  const info = db!
    .prepare(
      "INSERT INTO workflow_run_events (run_id, node_run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      input.runId,
      input.nodeRunId,
      input.type,
      JSON.stringify(input.payload),
      Date.now(),
    );
  const seq = Number(info.lastInsertRowid);
  return {
    seq,
    runId: input.runId,
    nodeRunId: input.nodeRunId,
    type: input.type,
    payload: input.payload,
    createdAt: Date.now(),
  };
}

export function listWorkflowRunEvents(
  runId: string,
  afterSeq = 0,
): WorkflowRunEvent[] {
  const rows = db!
    .prepare(
      "SELECT * FROM workflow_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC",
    )
    .all(runId, afterSeq) as any[];
  return rows.map(rowToWorkflowRunEvent);
}

/** 标记应用退出时仍处于活动状态的运行为中断（进程已不存在，不能假装还在跑） */
export function interruptStaleWorkflowRuns(): void {
  const now = Date.now();
  db!.prepare(
    "UPDATE workflow_runs SET status = 'interrupted', error = '应用已退出，运行被中断', finished_at = ? WHERE status IN ('queued','running','awaiting_approval')",
  ).run(now);
  db!.prepare(
    "UPDATE workflow_node_runs SET status = 'canceled', finished_at = ? WHERE status IN ('pending','running','awaiting_approval','retrying')",
  ).run(now);
}

// ============================================================================
// 设置操作
// ============================================================================

export function getSetting(key: string): string | null {
  const row = db!.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db!.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
  ).run(key, value, value);
}

// ============================================================================
// 自动化任务操作
// ============================================================================

export function listAutomationTasks(): AutomationTask[] {
  const rows = db!.prepare("SELECT * FROM automation_tasks ORDER BY created_at DESC").all() as any[];
  return rows.map(rowToAutomationTask);
}

export function getAutomationTask(id: string): AutomationTask | null {
  const row = db!.prepare("SELECT * FROM automation_tasks WHERE id = ?").get(id) as any;
  return row ? rowToAutomationTask(row) : null;
}

export function createAutomationTask(prompt: string, projectId: string, agentId: string): AutomationTask {
  const id = randomUUID();
  const now = Date.now();
  db!.prepare(
    "INSERT INTO automation_tasks (id, prompt, project_id, agent_id, status, session_id, created_at, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, prompt, projectId, agentId, "pending", null, now, null, null, null);
  return { id, prompt, projectId, agentId, status: "pending", sessionId: null, createdAt: now, startedAt: null, completedAt: null, error: null };
}

export function updateAutomationTask(id: string, fields: Partial<Omit<AutomationTask, "id" | "prompt" | "projectId" | "agentId" | "createdAt">>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.status !== undefined) { sets.push("status = ?"); vals.push(fields.status); }
  if (fields.sessionId !== undefined) { sets.push("session_id = ?"); vals.push(fields.sessionId); }
  if (fields.startedAt !== undefined) { sets.push("started_at = ?"); vals.push(fields.startedAt); }
  if (fields.completedAt !== undefined) { sets.push("completed_at = ?"); vals.push(fields.completedAt); }
  if (fields.error !== undefined) { sets.push("error = ?"); vals.push(fields.error); }
  if (sets.length === 0) return;
  vals.push(id);
  db!.prepare(`UPDATE automation_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function deleteAutomationTask(id: string): void {
  db!.prepare("DELETE FROM automation_tasks WHERE id = ?").run(id);
}

function rowToAutomationTask(row: any): AutomationTask {
  return {
    id: row.id,
    prompt: row.prompt,
    projectId: row.project_id,
    agentId: row.agent_id,
    status: row.status as AutomationStatus,
    sessionId: row.session_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

/** 关闭数据库 */
export function closeDatabase(): void {
  db?.close();
}
