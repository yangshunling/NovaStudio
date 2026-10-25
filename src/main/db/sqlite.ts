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
 * schema 变更走"加列 + 迁移"策略：检测到旧表缺列就 ALTER。
 *
 * 会话不再强依赖项目：project_id 为 NULL 表示未绑定工作目录，
 * 用户可在会话输入框处随时绑定 / 切换项目。
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
  EmployeeKnowledge,
  EmployeeMcpServer,
  EmployeeSkill,
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

/**
 * FTS5 是否可用。better-sqlite3 默认带 FTS5，但这里仍做一次防御：
 * 创建失败时检索会自动降级为 LIKE 扫描，不影响知识库的其它功能。
 */
let knowledgeFtsReady = false;

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

    -- Nova 创建的 MCP / Skill 标记。
    -- 资产定义统一放在 Claude 配置里；这张表只记录「哪些条目是 Nova 创建的」，
    -- 用于区分可编辑条目与 Claude 原有的只读条目。
    CREATE TABLE IF NOT EXISTS managed_assets (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
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
      knowledge_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kb_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      content TEXT NOT NULL,
      UNIQUE (kb_id, relative_path)
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_documents_kb
      ON knowledge_documents (kb_id);
  `);

  ensureKnowledgeFts();

  // === schema 迁移：只服务旧库 ===
  // 上面的 CREATE TABLE 已包含全部列，新装用户不会走到这里；
  // 旧库因表已存在而跳过 CREATE，故需要 ALTER 补齐后加的列。
  migrateSessionsProjectId();
  migrateSessionsMessageCount();
  migrateSessionsConfigDir();
  migrateSessionsSource();
  // 先清理旧版占位项目，再让工作区迁移把空归属的工作流挂到有效项目上
  migrateLegacyInboxProject();
  migrateWorkflowWorkspace();
  migrateEmployeeKnowledge();

  // 旧版本由 Nova 自己维护的 Agent 连接配置已废弃，统一改用各 CLI 本机配置
  db.exec("DROP TABLE IF EXISTS agent_connections;");

  // 未绑定项目的会话是合法状态，不再把孤儿会话收编到「收件箱」项目：
  // 否则每次启动都会把用户有意留空的会话重新绑定上。

  // 上次进程遗留的运行不可能还活着：统一标记为中断
  interruptStaleWorkflowRuns();
}

/**
 * 全文索引（FTS5 trigram）。
 *
 * trigram 分词器支持中文 / 英文的子串匹配，正合适 Wiki 式检索。
 * 表用 external content 模式，正文只存一份在 knowledge_documents 里。
 */
function ensureKnowledgeFts(): void {
  const exists = db!
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_fts'")
    .get();
  try {
    if (!exists) {
      db!.exec(`
        CREATE VIRTUAL TABLE knowledge_fts USING fts5(
          content,
          content='knowledge_documents',
          content_rowid='id',
          tokenize='trigram'
        );
      `);
      // 升级场景：文档表可能已有数据，创建索引后重建一次
      db!.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')");
    }
    knowledgeFtsReady = true;
  } catch {
    knowledgeFtsReady = false;
  }
}

/** 检测并给 digital_employees 表补 knowledge_json 列 */
function migrateEmployeeKnowledge(): void {
  const cols = db!.prepare("PRAGMA table_info(digital_employees)").all() as {
    name: string;
  }[];
  if (!cols.some((column) => column.name === "knowledge_json")) {
    db!.exec(
      "ALTER TABLE digital_employees ADD COLUMN knowledge_json TEXT NOT NULL DEFAULT '[]'",
    );
  }
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

/**
 * 清理旧版自动创建的「收件箱」项目。
 *
 * 旧版本把无 project_id 的会话收编到 name='收件箱' 且 cwd='' 的项目里。
 * 新模型允许会话不绑定项目，这个占位项目只会让项目选择器里出现一个
 * 没有目录的空条目 —— 把会话解绑后删掉它。
 */
function migrateLegacyInboxProject(): void {
  const inbox = db!
    .prepare("SELECT id FROM projects WHERE name = ? AND cwd = ''")
    .get("收件箱") as { id: string } | undefined;
  if (!inbox) return;

  // 极旧的库还没有 workspace_id 列：此时工作流不可能指向该收件箱，
  // 跳过工作流处理；随后的 migrateWorkflowWorkspace 会补列并重新归属。
  const workflowCols = db!.prepare("PRAGMA table_info(workflows)").all() as {
    name: string;
  }[];
  const hasWorkspaceId = workflowCols.some((c) => c.name === "workspace_id");

  db!.transaction(() => {
    db!.prepare("UPDATE sessions SET project_id = NULL WHERE project_id = ?").run(
      inbox.id,
    );
    if (hasWorkspaceId) {
      db!.prepare(
        "UPDATE workflows SET workspace_id = NULL WHERE workspace_id = ?",
      ).run(inbox.id);
    }
    db!.prepare("DELETE FROM projects WHERE id = ?").run(inbox.id);
  })();
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

/**
 * 创建新会话。title 取首条用户消息前缀。
 * projectId 可为 null —— 会话可以先创建、稍后再绑定工作目录。
 */
export function createSession(
  agentId: string,
  projectId: string | null,
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
/** 工作流/聊天在运行前确定使用哪个隔离配置目录时，回写会话记录 */
export function updateSessionConfigDir(
  sessionId: string,
  configDir: string,
): void {
  db!
    .prepare("UPDATE sessions SET config_dir = ? WHERE id = ?")
    .run(configDir, sessionId);
}

/**
 * 绑定 / 切换 / 解绑会话的项目，并同步工作目录。
 *
 * resetAgentSession 为 true 时清空 CLI 会话引用：切换目录后旧引用
 * （如 Claude 的会话文件按 cwd 归档）无法可靠恢复，主动开启新上下文，
 * 本地已持久化的消息不受影响。
 */
export function setSessionProject(
  sessionId: string,
  projectId: string | null,
  cwd: string,
  resetAgentSession: boolean,
): void {
  const now = Date.now();
  if (resetAgentSession) {
    db!.prepare(
      "UPDATE sessions SET project_id = ?, cwd = ?, agent_session_id = NULL, updated_at = ? WHERE id = ?",
    ).run(projectId, cwd, now, sessionId);
    return;
  }
  db!.prepare(
    "UPDATE sessions SET project_id = ?, cwd = ?, updated_at = ? WHERE id = ?",
  ).run(projectId, cwd, now, sessionId);
}

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

/**
 * 员工技能归一化。
 *
 * 旧版存的是 `{ id, name, source, enabled }` 路径条目；新版只存技能资产引用
 * `{ assetId, name, enabled }`。旧条目保留 source，运行时仍可按原语义解析，
 * 在 UI 中标记为「旧版路径」提示重新绑定。
 */
function normalizeEmployeeSkills(raw: string): EmployeeSkill[] {
  return parseJsonArray<Record<string, unknown>>(raw).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const name = typeof item.name === "string" ? item.name : "";
    const source = typeof item.source === "string" ? item.source : undefined;
    const assetId = typeof item.assetId === "string" ? item.assetId : "";
    if (!assetId && !source && !name) return [];
    return [
      {
        assetId,
        name: name || source || "未命名技能",
        ...(source ? { source } : {}),
        enabled: item.enabled !== false,
      },
    ];
  });
}

/**
 * 员工 MCP 归一化。
 *
 * 新版只存资产引用 `{ assetId, name, enabled }`；旧版是内联配置
 * `{ id, name, command, args, env, enabled }`。旧条目保留内联字段，
 * 运行时仍可注入，UI 中标记为「旧版内联」并提示导入 MCP 库。
 */
function normalizeEmployeeMcpServers(raw: string): EmployeeMcpServer[] {
  return parseJsonArray<Record<string, unknown>>(raw).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const assetId = typeof item.assetId === "string" ? item.assetId : "";
    const name = typeof item.name === "string" ? item.name : "";
    const enabled = item.enabled !== false;

    if (assetId) return [{ assetId, name, enabled }];

    const command = typeof item.command === "string" ? item.command : "";
    const args = typeof item.args === "string" ? item.args : "";
    const env = typeof item.env === "string" ? item.env : "";
    if (!command && !args && !env) return [];

    return [
      {
        assetId: "",
        name: name || command || "未命名 MCP",
        enabled,
        command,
        args,
        env,
      },
    ];
  });
}

/** 员工知识库归一化：只接受资产引用，损坏项直接丢弃 */
function normalizeEmployeeKnowledge(raw: string): EmployeeKnowledge[] {
  return parseJsonArray<Record<string, unknown>>(raw).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const assetId = typeof item.assetId === "string" ? item.assetId : "";
    if (!assetId) return [];
    return [
      {
        assetId,
        name: typeof item.name === "string" ? item.name : "",
        enabled: item.enabled !== false,
      },
    ];
  });
}

function rowToDigitalEmployee(row: any): DigitalEmployee {
  return {
    id: row.id,
    name: row.name,
    role: row.role ?? "",
    description: row.description ?? "",
    avatar: row.avatar ?? null,
    agentId: row.agent_id,
    systemPrompt: row.system_prompt ?? "",
    mcpServers: normalizeEmployeeMcpServers(row.mcp_servers_json),
    skills: normalizeEmployeeSkills(row.skills_json),
    knowledgeBases: normalizeEmployeeKnowledge(row.knowledge_json ?? "[]"),
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
    draft.systemPrompt,
    JSON.stringify(draft.mcpServers),
    JSON.stringify(draft.skills),
    JSON.stringify(draft.knowledgeBases ?? []),
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
      id, name, role, description, avatar, agent_id,
      system_prompt, mcp_servers_json, skills_json, knowledge_json,
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
        name = ?, role = ?, description = ?, avatar = ?, agent_id = ?,
        system_prompt = ?, mcp_servers_json = ?, skills_json = ?, knowledge_json = ?,
        enabled = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(...employeeParams(draft), Date.now(), id);
  return info.changes > 0 ? getDigitalEmployee(id) : null;
}

export function deleteDigitalEmployee(id: string): void {
  db!.prepare("DELETE FROM digital_employees WHERE id = ?").run(id);
}

/** 迁移时只更新员工的 MCP / Skill 引用，避免改动其它字段 */
export function updateEmployeeBindings(
  id: string,
  mcpServersJson: string,
  skillsJson: string,
): void {
  db!
    .prepare(
      "UPDATE digital_employees SET mcp_servers_json = ?, skills_json = ?, updated_at = ? WHERE id = ?",
    )
    .run(mcpServersJson, skillsJson, Date.now(), id);
}

// ============================================================================
// 知识库全文索引
// ============================================================================

export interface KnowledgeIndexMeta {
  relativePath: string;
  size: number;
  updatedAt: number;
}

export interface KnowledgeSearchRow {
  kbId: string;
  relativePath: string;
  snippet: string;
}

export function getKnowledgeIndexMeta(kbId: string): KnowledgeIndexMeta[] {
  const rows = db!
    .prepare(
      `SELECT relative_path AS relativePath, size, updated_at AS updatedAt
       FROM knowledge_documents WHERE kb_id = ?`,
    )
    .all(kbId) as KnowledgeIndexMeta[];
  return rows;
}

/** 写入 / 更新一个文档的索引（external content FTS 需要手动同步删除旧行） */
export function upsertKnowledgeDocument(input: {
  kbId: string;
  relativePath: string;
  name: string;
  size: number;
  updatedAt: number;
  content: string;
}): void {
  const existing = db!
    .prepare(
      "SELECT id, content FROM knowledge_documents WHERE kb_id = ? AND relative_path = ?",
    )
    .get(input.kbId, input.relativePath) as
    | { id: number; content: string }
    | undefined;

  const tx = db!.transaction(() => {
    if (existing) {
      if (knowledgeFtsReady) {
        db!
          .prepare(
            "INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES ('delete', ?, ?)",
          )
          .run(existing.id, existing.content);
      }
      db!
        .prepare(
          `UPDATE knowledge_documents
           SET name = ?, size = ?, updated_at = ?, content = ?
           WHERE id = ?`,
        )
        .run(input.name, input.size, input.updatedAt, input.content, existing.id);
      if (knowledgeFtsReady) {
        db!
          .prepare("INSERT INTO knowledge_fts(rowid, content) VALUES (?, ?)")
          .run(existing.id, input.content);
      }
      return;
    }

    const info = db!
      .prepare(
        `INSERT INTO knowledge_documents
         (kb_id, relative_path, name, size, updated_at, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kbId,
        input.relativePath,
        input.name,
        input.size,
        input.updatedAt,
        input.content,
      );
    if (knowledgeFtsReady) {
      db!
        .prepare("INSERT INTO knowledge_fts(rowid, content) VALUES (?, ?)")
        .run(info.lastInsertRowid, input.content);
    }
  });
  tx();
}

export function deleteKnowledgeDocument(
  kbId: string,
  relativePath: string,
): void {
  const row = db!
    .prepare(
      "SELECT id, content FROM knowledge_documents WHERE kb_id = ? AND relative_path = ?",
    )
    .get(kbId, relativePath) as { id: number; content: string } | undefined;
  if (!row) return;

  db!.transaction(() => {
    if (knowledgeFtsReady) {
      db!
        .prepare(
          "INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES ('delete', ?, ?)",
        )
        .run(row.id, row.content);
    }
    db!.prepare("DELETE FROM knowledge_documents WHERE id = ?").run(row.id);
  })();
}

export function deleteKnowledgeDocumentsByKb(kbId: string): void {
  const rows = db!
    .prepare("SELECT id, content FROM knowledge_documents WHERE kb_id = ?")
    .all(kbId) as { id: number; content: string }[];

  db!.transaction(() => {
    if (knowledgeFtsReady) {
      const del = db!.prepare(
        "INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES ('delete', ?, ?)",
      );
      for (const row of rows) del.run(row.id, row.content);
    }
    db!.prepare("DELETE FROM knowledge_documents WHERE kb_id = ?").run(kbId);
  })();
}

/** 把查询拆成检索词；空查询返回空数组 */
function splitSearchTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** 在片段中给所有检索词加高亮标记（\u0001 / \u0002） */
function highlightTerms(text: string, terms: string[]): string {
  let result = text;
  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    const lowerText = result.toLowerCase();
    let cursor = 0;
    let output = "";
    while (cursor < result.length) {
      const index = lowerText.indexOf(lowerTerm, cursor);
      if (index < 0) {
        output += result.slice(cursor);
        break;
      }
      output +=
        result.slice(cursor, index) +
        "\u0001" +
        result.slice(index, index + term.length) +
        "\u0002";
      cursor = index + term.length;
    }
    result = output;
  }
  return result;
}

/** LIKE 降级检索时自行截取命中片段 */
function buildSnippet(content: string, terms: string[], radius = 60): string {
  const lower = content.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0 && (first < 0 || index < first)) first = index;
  }

  if (first < 0) {
    return content.slice(0, radius * 2).replace(/\s+/g, " ").trim();
  }

  const start = Math.max(0, first - radius);
  const end = Math.min(content.length, first + radius * 2);
  const snippet = highlightTerms(content.slice(start, end), terms)
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${snippet}${end < content.length ? "…" : ""}`;
}

/**
 * 全文检索。
 *
 * 检索词都不短于 3 个字符时走 FTS5 trigram；否则（中文两字词、单字母等）
 * 降级为 LIKE 扫描，保证「产品」「AI」这类查询也能命中。
 */
export function searchKnowledgeDocuments(input: {
  query: string;
  kbId?: string;
  limit: number;
}): { rows: KnowledgeSearchRow[]; degraded: boolean } {
  const terms = splitSearchTerms(input.query);
  if (terms.length === 0) return { rows: [], degraded: false };

  const allLongEnough = terms.every((term) => [...term].length >= 3);

  if (knowledgeFtsReady && allLongEnough) {
    const match = terms
      .map((term) => `"${term.replace(/"/g, '""')}"`)
      .join(" AND ");
    const scope = input.kbId ? " AND d.kb_id = ?" : "";
    try {
      const rows = db!
        .prepare(
          `SELECT d.kb_id AS kbId, d.relative_path AS relativePath,
                  snippet(knowledge_fts, 0, char(1), char(2), '…', 24) AS snippet
           FROM knowledge_fts
           JOIN knowledge_documents d ON d.id = knowledge_fts.rowid
           WHERE knowledge_fts MATCH ?${scope}
           ORDER BY bm25(knowledge_fts)
           LIMIT ?`,
        )
        .all(
          ...(input.kbId
            ? [match, input.kbId, input.limit]
            : [match, input.limit]),
        ) as KnowledgeSearchRow[];
      return { rows, degraded: false };
    } catch {
      // 查询语法异常时继续走 LIKE 兜底
    }
  }

  const conditions = terms.map(() => "content LIKE ? ESCAPE '\\'");
  if (input.kbId) conditions.push("kb_id = ?");
  const values: unknown[] = terms.map((term) => `%${escapeLike(term)}%`);
  if (input.kbId) values.push(input.kbId);
  values.push(input.limit);

  const rows = db!
    .prepare(
      `SELECT kb_id AS kbId, relative_path AS relativePath, content
       FROM knowledge_documents
       WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(...values) as Array<{
    kbId: string;
    relativePath: string;
    content: string;
  }>;

  return {
    rows: rows.map((row) => ({
      kbId: row.kbId,
      relativePath: row.relativePath,
      snippet: buildSnippet(row.content, terms),
    })),
    degraded: true,
  };
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
// Nova 创建的资产标记
// ============================================================================

export type ManagedAssetKind = "mcp" | "skill";

export function listManagedAssetKeys(kind: ManagedAssetKind): string[] {
  const rows = db!
    .prepare("SELECT key FROM managed_assets WHERE kind = ?")
    .all(kind) as Array<{ key: string }>;
  return rows.map((row) => row.key);
}

export function isManagedAsset(
  kind: ManagedAssetKind,
  key: string,
): boolean {
  return Boolean(
    db!
      .prepare("SELECT 1 FROM managed_assets WHERE kind = ? AND key = ?")
      .get(kind, key),
  );
}

export function markManagedAsset(kind: ManagedAssetKind, key: string): void {
  db!
    .prepare(
      "INSERT OR IGNORE INTO managed_assets (kind, key, created_at) VALUES (?, ?, ?)",
    )
    .run(kind, key, Date.now());
}

export function unmarkManagedAsset(
  kind: ManagedAssetKind,
  key: string,
): void {
  db!
    .prepare("DELETE FROM managed_assets WHERE kind = ? AND key = ?")
    .run(kind, key);
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
