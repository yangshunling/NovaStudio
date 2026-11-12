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
 * schema 由下方的建表语句一次性定义，并用 PRAGMA user_version 标记版本；
 * 发版前不保留增量迁移，旧库会备份后按当前 schema 重建。
 *
 * 会话不再强依赖项目：project_id 为 NULL 表示未绑定工作目录，
 * 用户可在会话输入框处随时绑定 / 切换项目。
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { existsSync, renameSync } from "fs";
import type {
  Project,
  Session,
  Message,
  TodoDraft,
  TodoItem,
  TodoPriority,
  AutomationTask,
  AutomationStatus,
  DigitalEmployee,
  DigitalEmployeeDraft,
  EmployeeKnowledge,
  EmployeeMcpServer,
  EmployeeSkill,
  PromptDraft,
  PromptItem,
  SessionSource,
  Workflow,
  WorkflowDraft,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeAttemptKind,
  WorkflowNodeRun,
  WorkflowNodeRunStatus,
  WorkflowRun,
  WorkflowRunEvent,
  WorkflowRunEventType,
  WorkflowRunStatus,
  WorkflowTrigger,
  WorkflowTriggerBinding,
  WorkflowTriggerDraft,
} from "../../shared/types";
import { normalizeTriggerSchedule } from "../../shared/trigger-schedule";
import { clamp } from "../../shared/math";
import { parseJsonArray } from "../../shared/json";
import { DB_PATH, ensureDataDirs } from "../utils/paths";

let db: Database.Database | null = null;

/**
 * prepared statement 缓存。
 *
 * better-sqlite3 的 prepare 每次都会编译 SQL；同一句 SQL 在不同函数里反复
 * `db.prepare(...)`（本文件 80+ 处）意味着每条语句在每次调用时都重新编译。
 * 这里按 SQL 文本缓存复用，命中即返回同一 statement，只在数据库关闭时清空。
 * SQL 全是固定字面量（无拼接），语句数量有界，缓存不会失控。
 */
const stmtCache = new Map<string, Database.Statement>();

/** prepare 的缓存包装：重复的 SQL 命中同一 Statement，避免反复编译 */
function prepare(sql: string): Database.Statement {
  let statement = stmtCache.get(sql);
  if (!statement) {
    statement = db!.prepare(sql);
    stmtCache.set(sql, statement);
  }
  return statement;
}

/** 数据库关闭后旧 statement 指向已关闭的连接，统一失效 */
function clearStmtCache(): void {
  stmtCache.clear();
}

/**
 * FTS5 是否可用。better-sqlite3 默认带 FTS5，但这里仍做一次防御：
 * 创建失败时检索会自动降级为 LIKE 扫描，不影响知识库的其它功能。
 */
let knowledgeFtsReady = false;

/**
 * 当前 schema 版本。
 *
 * 发版前只有一个基线版本：结构变更直接改建表语句，不写增量迁移。
 * 发版之后要改表时，把版本 +1，并在 initDatabase 里补一段顺序升级。
 */
const SCHEMA_VERSION = 1;

/** 打开连接并应用连接级 pragma（重建库后需要重新执行） */
function openDatabase(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
}

/**
 * 发版前的旧库没有版本号（user_version = 0），结构可能与本版本的建表语句不一致，
 * 而 CREATE TABLE IF NOT EXISTS 会静默跳过已有表，导致后续查询缺列。
 * 这里把旧库文件改名备份后按当前 schema 重建，避免半新半旧的结构共存。
 */
function resetLegacyDatabase(): void {
  const version = db!.pragma("user_version", { simple: true }) as number;
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本 ${version} 高于当前应用支持的 ${SCHEMA_VERSION}`,
    );
  }

  // 全新安装：文件里没有任何表，直接按建表语句初始化
  const hasTables = db!
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
    )
    .get();
  if (!hasTables) return;

  const backup = `${DB_PATH}.bak-${Date.now()}`;
  clearStmtCache();
  db!.close();
  db = null;
  renameSync(DB_PATH, backup);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${DB_PATH}${suffix}`)) {
      renameSync(`${DB_PATH}${suffix}`, `${backup}${suffix}`);
    }
  }
  console.warn(`[db] 旧版本数据库已备份至 ${backup}，按当前 schema 重建`);
  openDatabase();
}

/**
 * 幂等补列。
 *
 * 发版后的库不能靠「版本不一致就重建」来加字段——那会把用户数据整体丢掉。
 * 新字段统一走这里：已存在则跳过，不存在才 ALTER。
 */
function ensureColumn(
  conn: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = conn
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** 初始化数据库连接和表结构 */
export function initDatabase(): void {
  ensureDataDirs();
  openDatabase();
  resetLegacyDatabase();
  // resetLegacyDatabase 可能重建连接，这里取重建后的实例
  const conn = db!;

  conn.exec(`
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
      -- 会话绑定的数字员工；NULL 表示普通会话（走 Agent 全局配置）
      employee_id TEXT,
      agent_id TEXT NOT NULL,
      agent_session_id TEXT,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      config_dir TEXT,
      source TEXT NOT NULL DEFAULT 'chat',
      message_count INTEGER NOT NULL DEFAULT 0,
      -- 本地 messages 是否已经覆盖完整历史。
      -- 0 表示会话可能还有 CLI 侧历史未被导入，下一次运行前会先补全。
      history_complete INTEGER NOT NULL DEFAULT 0,
      -- 置顶时间；NULL 表示未置顶。只影响列表顺序，不改 updated_at。
      pinned_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      -- 本条回复的数字员工；NULL 表示 Agent 全局配置
      employee_id TEXT,
      content_json TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    -- 消息按会话回放时始终是 (session_id, timestamp) 有序读取
    CREATE INDEX IF NOT EXISTS idx_messages_session_time
      ON messages (session_id, timestamp);

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

    -- 个人待办：与应用内其它实体完全独立，只服务「记录 → 完成」这一条链路。
    -- tags_json 存字符串数组；sort_order 为手动排序值，新条目取当前最小值 - 1，
    -- 因此默认排在最前面。
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal',
      due_at INTEGER,
      tags_json TEXT NOT NULL DEFAULT '[]',
      done INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_todos_done_completed
      ON todos (done, completed_at DESC);

    -- 常用提示词：独立资产，只服务「收藏 → 查找 → 复用」。
    -- tags_json 存字符串数组；收藏条目在列表里固定排在前面。
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      favorite INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prompts_favorite_updated
      ON prompts (favorite DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 触发器与工作流是多对多：一个触发器可定时启动多条工作流，
    -- 一条工作流也可以被多个触发器驱动。
    CREATE TABLE IF NOT EXISTS workflow_triggers (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fired_at INTEGER,
      next_fire_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_trigger_bindings (
      trigger_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      PRIMARY KEY (trigger_id, workflow_id)
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_trigger_bindings_workflow
      ON workflow_trigger_bindings (workflow_id);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      graph_json TEXT NOT NULL,
      artifact_dir TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      trigger_id TEXT,
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
      round INTEGER NOT NULL DEFAULT 1,
      max_retries INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      artifact_dir TEXT,
      input_path TEXT,
      output_path TEXT,
      output_summary TEXT,
      error TEXT,
      decision TEXT,
      decision_note TEXT,
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
      -- 同一 attempt 内人工要求修改会复用会话，用 round 区分每一轮调用
      round INTEGER NOT NULL DEFAULT 1,
      -- initial / retry / revise
      kind TEXT NOT NULL DEFAULT 'initial',
      session_id TEXT,
      artifact_dir TEXT,
      -- 本轮在 messages 表里的起止消息，运行详情据此切分对话
      user_message_id TEXT,
      assistant_message_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_run
      ON workflow_node_runs (run_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_node_attempts_run
      ON workflow_node_attempts (run_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_run_events_run
      ON workflow_run_events (run_id, seq);
    -- 节点详情 / 告警列表按 node_run_id 过滤并按 seq 排序
    CREATE INDEX IF NOT EXISTS idx_workflow_run_events_node
      ON workflow_run_events (node_run_id, seq);
    -- 运行记录列表按工作流 / 工作区过滤并按创建时间倒序，三条路径都要走索引
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow
      ON workflow_runs (workflow_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace
      ON workflow_runs (workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_created
      ON workflow_runs (created_at DESC);

    CREATE TABLE IF NOT EXISTS digital_employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      avatar TEXT,
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

  // 已发版的库不会因版本号相同而重建；这里幂等补列，避免清空用户数据
  ensureColumn(conn, "sessions", "employee_id", "TEXT");
  ensureColumn(conn, "messages", "employee_id", "TEXT");

  ensureKnowledgeFts();

  // 上次进程遗留的运行不可能还活着：统一标记为中断
  interruptStaleWorkflowRuns();

  conn.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_chat_updated
      ON sessions (updated_at DESC) WHERE source <> 'workflow';
    CREATE INDEX IF NOT EXISTS idx_sessions_project
      ON sessions (project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_employee
      ON sessions (employee_id);
    -- 节点详情 / 尝试列表按节点过滤
    CREATE INDEX IF NOT EXISTS idx_workflow_node_attempts_node
      ON workflow_node_attempts (node_run_id, attempt, round);
  `);

  conn.pragma(`user_version = ${SCHEMA_VERSION}`);
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

// ============================================================================
// 项目操作
// ============================================================================

export function listProjects(): Project[] {
  const rows = prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as any[];
  return rows.map(rowToProject);
}

export function getProject(id: string): Project | null {
  const row = prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
  return row ? rowToProject(row) : null;
}

export function createProject(name: string, cwd: string): Project {
  const id = randomUUID();
  const now = Date.now();
  prepare(
    "INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, name, cwd, now, now);
  return { id, name, cwd, createdAt: now, updatedAt: now };
}

/**
 * 删除项目及其下所有会话（sessions/messages 经外键级联删除）。
 * CLI 侧会话文件的清理由 IPC handler 在调用本函数前完成。
 */
export function deleteProject(id: string): void {
  // 删除会话、自动化任务与项目包在同一个事务里，保证原子性（任一失败则整体回滚）。
  // 任务不同步清理的话，轮询器之后会对着已不存在的项目反复失败。
  db!.transaction(() => {
    prepare("DELETE FROM automation_tasks WHERE project_id = ?").run(id);
    prepare("DELETE FROM sessions WHERE project_id = ?").run(id);
    prepare("DELETE FROM projects WHERE id = ?").run(id);
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
  employeeId?: string | null,
): Session {
  const id = randomUUID();
  const now = Date.now();
  const resolvedTitle = title || "新会话";

  prepare(
    "INSERT INTO sessions (id, project_id, employee_id, agent_id, agent_session_id, title, cwd, config_dir, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    projectId,
    employeeId ?? null,
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
    employeeId: employeeId ?? null,
    source,
    agentId,
    agentSessionId: null,
    title: resolvedTitle,
    cwd,
    configDir: configDir ?? null,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    pinnedAt: null,
    messages: [],
  };
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
    prepare(
      "UPDATE sessions SET project_id = ?, cwd = ?, agent_session_id = NULL, updated_at = ? WHERE id = ?",
    ).run(projectId, cwd, now, sessionId);
    return;
  }
  prepare(
    "UPDATE sessions SET project_id = ?, cwd = ?, updated_at = ? WHERE id = ?",
  ).run(projectId, cwd, now, sessionId);
}

/**
 * 清空会话的 CLI 引用（CLI 侧会话已不存在 / 无法恢复时使用）。
 * 保留本地 messages，界面历史不丢；下一次运行会自动开启新上下文。
 */
export function clearAgentSessionId(sessionId: string): void {
  prepare(
    "UPDATE sessions SET agent_session_id = NULL, updated_at = ? WHERE id = ?",
  ).run(Date.now(), sessionId);
}

/** 更新会话的 agent session 引用（用于多轮 --resume；引用形态由 provider 解释） */
export function updateAgentSessionId(sessionId: string, agentSessionId: string): void {
  prepare(
    "UPDATE sessions SET agent_session_id = ?, updated_at = ? WHERE id = ?",
  ).run(agentSessionId, Date.now(), sessionId);
}

/**
 * 切换会话当前使用的数字员工。
 *
 * 只改 employee_id，不触碰 agent_session_id / config_dir：
 * 会话的 CLI 上下文由会话级 projects 目录承载，换员工不能丢上下文。
 * 也不更新 updated_at，避免仅切换员工就把会话顶到列表最前。
 */
export function setSessionEmployee(
  sessionId: string,
  employeeId: string | null,
): void {
  prepare("UPDATE sessions SET employee_id = ? WHERE id = ?").run(
    employeeId,
    sessionId,
  );
}

/**
 * 记录会话实际使用的 CLI 配置目录（数字员工 home）。
 *
 * 必须在启动进程前落库：历史回放 / --resume 都按这个目录定位会话 JSONL，
 * 晚一步就等于在旧目录里找一个不存在的会话。
 */
export function setSessionConfigDir(
  sessionId: string,
  configDir: string | null,
): void {
  prepare("UPDATE sessions SET config_dir = ? WHERE id = ?").run(
    configDir,
    sessionId,
  );
}

/**
 * 清除会话的 CLI 引用（config_dir + agent_session_id）。
 *
 * 工作流 attempt 结束时 JSONL 已删除，本地 messages 仍然保留，
 * 因此可以安全地丢掉这两个定位字段，避免后续反复扫描 projects 目录。
 */
export function clearSessionCliRef(sessionId: string): void {
  prepare(
    "UPDATE sessions SET agent_session_id = NULL, config_dir = NULL WHERE id = ?",
  ).run(sessionId);
}

/** 仍持有 CLI 引用的工作流会话（启动时清理异常退出遗留的 JSONL） */
export function listWorkflowSessionIdsWithCliRef(): string[] {
  const rows = prepare(
    "SELECT id FROM sessions WHERE source = 'workflow' AND agent_session_id IS NOT NULL",
  ).all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** 使用某数字员工的会话（用于删除前的影响提示） */
export function listSessionsByEmployee(employeeId: string): Session[] {
  const rows = db!
    .prepare(
      "SELECT * FROM sessions WHERE employee_id = ? AND source <> 'workflow' ORDER BY updated_at DESC",
    )
    .all(employeeId) as any[];
  return rows.map(rowToSession);
}

/**
 * 员工被强制删除后，解除其会话绑定。
 *
 * config_dir / agent_session_id 属于会话本身，不能随员工清除：
 * 会话级 projects 里还有完整的 CLI 对话，下一次发送会切到 base-home 继续。
 */
export function clearEmployeeBindings(employeeId: string): void {
  prepare("UPDATE sessions SET employee_id = NULL WHERE employee_id = ?").run(
    employeeId,
  );
}

/** 更新会话标题 */
export function setSessionTitle(sessionId: string, title: string): void {
  prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(
    title,
    Date.now(),
    sessionId,
  );
}

/**
 * 置顶 / 取消置顶会话。
 * 不改 updated_at：置顶是浏览偏好，不应把会话重新算进「今天」或改变排序时间。
 */
export function setSessionPinned(sessionId: string, pinned: boolean): void {
  prepare("UPDATE sessions SET pinned_at = ? WHERE id = ?").run(
    pinned ? Date.now() : null,
    sessionId,
  );
}

/**
 * 追加一条消息到 messages 表（content_json 存储 AgentEvent[] 的 JSON 序列化）。
 * 一次 run 产生一条 user 消息 + 一条 assistant 消息；多次 run（对话场景）自然追加。
 */
export function saveSessionMessage(sessionId: string, msg: Message): void {
  prepare(
    "INSERT INTO messages (id, session_id, role, employee_id, content_json, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    msg.id,
    sessionId,
    msg.role,
    msg.employeeId ?? null,
    JSON.stringify(msg.content),
    msg.timestamp,
  );
}

/** 读取会话的全部持久化消息（按时间正序）。无数据时返回 null，表示回退到 provider 回放。 */
export function readSessionMessages(sessionId: string): Message[] | null {
  const rows = prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC",
  ).all(sessionId) as any[];
  if (rows.length === 0) return null;

  const messages: Message[] = [];
  for (const row of rows) {
    try {
      messages.push({
        id: row.id,
        role: row.role,
        content: JSON.parse(row.content_json),
        timestamp: row.timestamp,
        /*
         * NULL 视为「没有记录」而不是「当时就没用员工」：
         * 补列前的历史消息都是 NULL，交给渲染层回退到会话当前绑定，
         * 否则升级后老会话的回复会全部退回 Claude 头像。
         */
        employeeId: row.employee_id ?? undefined,
      });
    } catch {
      // 单条消息损坏不应让整个会话打不开：跳过它，其余历史照常回放
    }
  }
  return messages.length > 0 ? messages : null;
}

/** 会话是否已有本地消息（用于判断运行前是否需要从 CLI 侧补全历史） */
export function hasSessionMessages(sessionId: string): boolean {
  return Boolean(
    prepare("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1").get(
      sessionId,
    ),
  );
}

/** 批量导入历史消息（一次事务，避免逐条写入放大 IO） */
export function importSessionMessages(
  sessionId: string,
  messages: Message[],
): void {
  if (messages.length === 0) return;
  const insert = prepare(
    "INSERT OR IGNORE INTO messages (id, session_id, role, employee_id, content_json, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
  );
  db!.transaction(() => {
    for (const message of messages) {
      insert.run(
        message.id || randomUUID(),
        sessionId,
        message.role,
        message.employeeId ?? null,
        JSON.stringify(message.content),
        message.timestamp,
      );
    }
  })();
}

/** 本地 messages 是否已经覆盖该会话的完整历史 */
export function isSessionHistoryComplete(sessionId: string): boolean {
  const row = prepare(
    "SELECT history_complete FROM sessions WHERE id = ?",
  ).get(sessionId) as { history_complete?: number } | undefined;
  return row?.history_complete === 1;
}

/** 标记会话的本地消息已经覆盖完整历史 */
export function markSessionHistoryComplete(sessionId: string): void {
  prepare(
    "UPDATE sessions SET history_complete = 1 WHERE id = ?",
  ).run(sessionId);
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
    prepare(
      "UPDATE sessions SET title = ?, updated_at = ?, message_count = message_count + ? WHERE id = ?",
    ).run(opts.title, now, delta, sessionId);
  } else {
    prepare(
      "UPDATE sessions SET updated_at = ?, message_count = message_count + ? WHERE id = ?",
    ).run(now, delta, sessionId);
  }
}

/** 数据库行 → Session 对象（列表与单查共用；正文不入库，messages 留空由调用方回放填充） */
function rowToSession(row: any): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    employeeId: row.employee_id ?? null,
    source: (row.source ?? "chat") as Session["source"],
    agentId: row.agent_id,
    agentSessionId: row.agent_session_id,
    title: row.title,
    cwd: row.cwd,
    configDir: row.config_dir ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count ?? 0,
    pinnedAt: row.pinned_at ?? null,
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
      // source 列是 NOT NULL DEFAULT 'chat'，不需要 COALESCE；
      // 包一层函数会让部分索引 idx_sessions_chat_updated 失效。
      "SELECT * FROM sessions WHERE source <> 'workflow' ORDER BY updated_at DESC",
    )
    .all() as any[];
  return rows.map(rowToSession);
}

/**
 * 获取会话元数据。正文不入库——由 agent-service 调 provider 回放后填充 messages 字段。
 */
export function getSession(id: string): Session | null {
  const row = prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
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
  prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

// ============================================================================
// 数字员工操作
// ============================================================================

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
  const row = prepare("SELECT * FROM digital_employees WHERE id = ?").get(id) as any;
  return row ? rowToDigitalEmployee(row) : null;
}

export function createDigitalEmployee(draft: DigitalEmployeeDraft): DigitalEmployee {
  const id = randomUUID();
  const now = Date.now();
  prepare(
    `INSERT INTO digital_employees (
      id, name, role, description, avatar,
      system_prompt, mcp_servers_json, skills_json, knowledge_json,
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        name = ?, role = ?, description = ?, avatar = ?,
        system_prompt = ?, mcp_servers_json = ?, skills_json = ?, knowledge_json = ?,
        enabled = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(...employeeParams(draft), Date.now(), id);
  return info.changes > 0 ? getDigitalEmployee(id) : null;
}

export function deleteDigitalEmployee(id: string): void {
  prepare("DELETE FROM digital_employees WHERE id = ?").run(id);
}

/** 只更新员工的 MCP / Skill 引用，避免改动其它字段 */
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
    prepare("DELETE FROM knowledge_documents WHERE id = ?").run(row.id);
  })();
}

export function deleteKnowledgeDocumentsByKb(kbId: string): void {
  const rows = db!
    .prepare("SELECT id, content FROM knowledge_documents WHERE kb_id = ?")
    .all(kbId) as { id: number; content: string }[];

  db!.transaction(() => {
    if (knowledgeFtsReady) {
      const del = prepare(
        "INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES ('delete', ?, ?)",
      );
      for (const row of rows) del.run(row.id, row.content);
    }
    prepare("DELETE FROM knowledge_documents WHERE kb_id = ?").run(kbId);
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
 * 单节点归一化：兜住手工编辑或损坏的 graph_json，
 * 策略 / 门禁字段缺失时补默认值（失败停止 + 自动通过）。
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
      maxRevisions:
        typeof config.maxRevisions === "number"
          ? clamp(Math.round(config.maxRevisions), 0, 3)
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
  const row = prepare("SELECT * FROM workflows WHERE id = ?").get(id) as any;
  return row ? rowToWorkflow(row) : null;
}

export function createWorkflow(draft: WorkflowDraft): Workflow {
  const id = randomUUID();
  const now = Date.now();
  prepare(
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
  db!.transaction(() => {
    prepare("DELETE FROM workflow_trigger_bindings WHERE workflow_id = ?").run(
      id,
    );
    prepare("DELETE FROM workflows WHERE id = ?").run(id);
  })();
}

// ============================================================================
// 工作流触发器
// ============================================================================

function rowToWorkflowTrigger(row: any): WorkflowTrigger {
  let rawSchedule: unknown = null;
  try {
    rawSchedule = JSON.parse(row.schedule_json);
  } catch {
    // 损坏的规则回退到默认值（normalize 内部兜底）
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    schedule: normalizeTriggerSchedule(rawSchedule),
    enabled: row.enabled === 1,
    lastFiredAt: row.last_fired_at ?? null,
    nextFireAt: row.next_fire_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWorkflowTriggers(): WorkflowTrigger[] {
  const rows = db!
    .prepare("SELECT * FROM workflow_triggers ORDER BY created_at DESC")
    .all() as any[];
  return rows.map(rowToWorkflowTrigger);
}

export function getWorkflowTrigger(id: string): WorkflowTrigger | null {
  const row = db!
    .prepare("SELECT * FROM workflow_triggers WHERE id = ?")
    .get(id) as any;
  return row ? rowToWorkflowTrigger(row) : null;
}

export function createWorkflowTrigger(
  draft: WorkflowTriggerDraft,
  nextFireAt: number | null,
): WorkflowTrigger {
  const id = randomUUID();
  const now = Date.now();
  prepare(
    "INSERT INTO workflow_triggers (id, title, description, schedule_json, enabled, last_fired_at, next_fire_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    draft.title,
    draft.description,
    JSON.stringify(draft.schedule),
    draft.enabled ? 1 : 0,
    null,
    nextFireAt,
    now,
    now,
  );
  return getWorkflowTrigger(id)!;
}

export function updateWorkflowTrigger(
  id: string,
  draft: WorkflowTriggerDraft,
  nextFireAt: number | null,
): WorkflowTrigger | null {
  const info = db!
    .prepare(
      "UPDATE workflow_triggers SET title = ?, description = ?, schedule_json = ?, enabled = ?, next_fire_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      draft.title,
      draft.description,
      JSON.stringify(draft.schedule),
      draft.enabled ? 1 : 0,
      nextFireAt,
      Date.now(),
      id,
    );
  return info.changes > 0 ? getWorkflowTrigger(id) : null;
}

/** 只更新运行状态字段（调度器触发后 / 启动时重算下次时间用） */
export function updateWorkflowTriggerRuntime(
  id: string,
  patch: {
    lastFiredAt?: number;
    nextFireAt?: number | null;
    lastError?: string | null;
  },
): WorkflowTrigger | null {
  const current = getWorkflowTrigger(id);
  if (!current) return null;

  prepare(
    "UPDATE workflow_triggers SET last_fired_at = ?, next_fire_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
  ).run(
    patch.lastFiredAt !== undefined ? patch.lastFiredAt : current.lastFiredAt,
    patch.nextFireAt !== undefined ? patch.nextFireAt : current.nextFireAt,
    patch.lastError !== undefined ? patch.lastError : current.lastError,
    Date.now(),
    id,
  );
  return getWorkflowTrigger(id);
}

export function deleteWorkflowTrigger(id: string): boolean {
  let deleted = false;
  db!.transaction(() => {
    prepare("DELETE FROM workflow_trigger_bindings WHERE trigger_id = ?").run(
      id,
    );
    deleted =
      prepare("DELETE FROM workflow_triggers WHERE id = ?").run(id).changes >
      0;
  })();
  return deleted;
}

export function listWorkflowTriggerBindings(): WorkflowTriggerBinding[] {
  const rows = db!
    .prepare("SELECT trigger_id, workflow_id FROM workflow_trigger_bindings")
    .all() as any[];
  return rows.map((row) => ({
    triggerId: row.trigger_id,
    workflowId: row.workflow_id,
  }));
}

export function listWorkflowTriggerIdsForWorkflow(workflowId: string): string[] {
  const rows = db!
    .prepare(
      "SELECT trigger_id FROM workflow_trigger_bindings WHERE workflow_id = ?",
    )
    .all(workflowId) as { trigger_id: string }[];
  return rows.map((row) => row.trigger_id);
}

/** 绑定到某个触发器的工作流 id（调度器触发时使用） */
export function listWorkflowIdsForTrigger(triggerId: string): string[] {
  const rows = db!
    .prepare(
      "SELECT workflow_id FROM workflow_trigger_bindings WHERE trigger_id = ?",
    )
    .all(triggerId) as { workflow_id: string }[];
  return rows.map((row) => row.workflow_id);
}

/** 用给定集合整体替换某个工作流的触发器绑定 */
export function setWorkflowTriggers(
  workflowId: string,
  triggerIds: string[],
): void {
  const unique = [...new Set(triggerIds)];
  db!.transaction(() => {
    prepare(
      "DELETE FROM workflow_trigger_bindings WHERE workflow_id = ?",
    ).run(workflowId);
    const insert = prepare(
      "INSERT OR IGNORE INTO workflow_trigger_bindings (trigger_id, workflow_id) VALUES (?, ?)",
    );
    for (const triggerId of unique) {
      // 只接受真实存在的触发器，避免渲染层传入过期 id 造成孤儿绑定
      if (!getWorkflowTrigger(triggerId)) continue;
      insert.run(triggerId, workflowId);
    }
  })();
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
      prepare("DELETE FROM workflow_run_events WHERE run_id = ?").run(runId);
      prepare("DELETE FROM workflow_node_attempts WHERE run_id = ?").run(runId);
      prepare("DELETE FROM workflow_node_runs WHERE run_id = ?").run(runId);
      prepare("DELETE FROM workflow_runs WHERE id = ?").run(runId);
    }
  })();

  return { runIds, sessionIds: [...sessionIds] };
}

/**
 * 删除单次运行及其节点记录 / 事件；返回会话与运行记录，供调用方清理磁盘。
 */
export function deleteWorkflowRun(runId: string): {
  run: WorkflowRun | null;
  sessionIds: string[];
} {
  const run = getWorkflowRun(runId);
  if (!run) return { run: null, sessionIds: [] };

  const sessionIds = new Set<string>();
  const nodeRows = db!
    .prepare("SELECT session_id FROM workflow_node_runs WHERE run_id = ?")
    .all(runId) as { session_id: string | null }[];
  const attemptRows = db!
    .prepare("SELECT session_id FROM workflow_node_attempts WHERE run_id = ?")
    .all(runId) as { session_id: string | null }[];
  for (const row of [...nodeRows, ...attemptRows]) {
    if (row.session_id) sessionIds.add(row.session_id);
  }

  db!.transaction(() => {
    prepare("DELETE FROM workflow_run_events WHERE run_id = ?").run(runId);
    prepare("DELETE FROM workflow_node_attempts WHERE run_id = ?").run(runId);
    prepare("DELETE FROM workflow_node_runs WHERE run_id = ?").run(runId);
    prepare("DELETE FROM workflow_runs WHERE id = ?").run(runId);
  })();

  return { run, sessionIds: [...sessionIds] };
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
    source: (row.source ?? "manual") as WorkflowRun["source"],
    triggerId: row.trigger_id ?? null,
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
    round: row.round ?? 1,
    maxRetries: row.max_retries ?? 0,
    sessionId: row.session_id ?? null,
    artifactDir: row.artifact_dir ?? null,
    inputPath: row.input_path ?? null,
    outputPath: row.output_path ?? null,
    outputSummary: row.output_summary ?? null,
    error: row.error ?? null,
    decision: row.decision ?? null,
    decisionNote: row.decision_note ?? null,
    decidedAt: row.decided_at ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
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
  source?: WorkflowRun["source"];
  triggerId?: string | null;
  createdAt: number;
}): WorkflowRun {
  prepare(
    `INSERT INTO workflow_runs (
      id, workflow_id, workspace_id, workflow_name, workspace_path,
      graph_json, artifact_dir, status, source, trigger_id, error,
      created_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
  ).run(
    input.id,
    input.workflowId,
    input.workspaceId,
    input.workflowName,
    input.workspacePath,
    JSON.stringify(input.graph),
    input.artifactDir,
    input.status,
    input.source ?? "manual",
    input.triggerId ?? null,
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

/** 全局活跃运行：侧栏徽标、待审核提醒使用（不含已结束的运行） */
export function listActiveWorkflowRuns(): WorkflowRun[] {
  const rows = db!
    .prepare(
      "SELECT * FROM workflow_runs WHERE status IN ('running','awaiting_approval') ORDER BY created_at ASC",
    )
    .all() as any[];
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
  prepare(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`).run(
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
  prepare(
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
 * 记录一次节点调用（一轮执行 / 重试 / 修改）的会话与产物目录。
 *
 * workflow_node_runs.session_id 只保存最新一轮，历次调用的会话靠这张表保留引用：
 * - 删除工作流时才能把全部会话清理掉；
 * - 同一 attempt 的 revise 轮次共用 sessionId，靠 round / kind 区分。
 */
export function createWorkflowNodeAttempt(input: {
  id: string;
  runId: string;
  nodeRunId: string;
  attempt: number;
  round: number;
  kind: WorkflowNodeAttemptKind;
  sessionId: string | null;
  artifactDir: string | null;
}): void {
  prepare(
    `INSERT INTO workflow_node_attempts (
      id, run_id, node_run_id, attempt, round, kind,
      session_id, artifact_dir, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.runId,
    input.nodeRunId,
    input.attempt,
    input.round,
    input.kind,
    input.sessionId,
    input.artifactDir,
    Date.now(),
  );
}

/** 本轮运行结束后回填消息边界，运行详情据此切分每次调用产生的对话 */
export function updateWorkflowNodeAttemptMessages(
  id: string,
  patch: { userMessageId?: string | null; assistantMessageId?: string | null },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.userMessageId !== undefined) {
    sets.push("user_message_id = ?");
    values.push(patch.userMessageId);
  }
  if (patch.assistantMessageId !== undefined) {
    sets.push("assistant_message_id = ?");
    values.push(patch.assistantMessageId);
  }
  if (sets.length === 0) return;
  values.push(id);
  prepare(
    `UPDATE workflow_node_attempts SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...values);
}

/** 某节点的全部调用（按尝试 / 轮次升序）；运行详情用它还原完整对话 */
export function listWorkflowNodeAttempts(nodeRunId: string): Array<{
  attempt: number;
  round: number;
  kind: WorkflowNodeAttemptKind;
  sessionId: string | null;
  artifactDir: string | null;
  userMessageId: string | null;
  assistantMessageId: string | null;
}> {
  const rows = db!
    .prepare(
      "SELECT attempt, round, kind, session_id, artifact_dir, user_message_id, assistant_message_id FROM workflow_node_attempts WHERE node_run_id = ? ORDER BY attempt ASC, round ASC, rowid ASC",
    )
    .all(nodeRunId) as any[];
  return rows.map((row) => ({
    attempt: row.attempt,
    round: row.round ?? 1,
    kind: (row.kind ?? "initial") as WorkflowNodeAttemptKind,
    sessionId: row.session_id ?? null,
    artifactDir: row.artifact_dir ?? null,
    userMessageId: row.user_message_id ?? null,
    assistantMessageId: row.assistant_message_id ?? null,
  }));
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
  round: "round",
  sessionId: "session_id",
  artifactDir: "artifact_dir",
  inputPath: "input_path",
  outputPath: "output_path",
  outputSummary: "output_summary",
  error: "error",
  decision: "decision",
  decisionNote: "decision_note",
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
      | "round"
      | "sessionId"
      | "artifactDir"
      | "inputPath"
      | "outputPath"
      | "outputSummary"
      | "error"
      | "decision"
      | "decisionNote"
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
  prepare(
    `UPDATE workflow_node_runs SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...values);
}

/**
 * 节点运行提示：把事件表里对用户有意义的告警 / 重试 / 审批取出来。
 * 只取最近 200 条，避免长运行把详情页撑爆。
 */
export function listWorkflowNodeNotices(nodeRunId: string): Array<{
  type: string;
  level: string;
  message: string;
  createdAt: number;
}> {
  const rows = db!
    .prepare(
      "SELECT type, payload_json, created_at FROM workflow_run_events WHERE node_run_id = ? AND type IN ('log','node_retry','approval_decided') ORDER BY seq ASC LIMIT 200",
    )
    .all(nodeRunId) as any[];

  const notices: Array<{
    type: string;
    level: string;
    message: string;
    createdAt: number;
  }> = [];

  for (const row of rows) {
    let payload: any = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    let message = "";
    let level = String(payload.level ?? "info");
    if (row.type === "log") {
      message = String(payload.message ?? "");
    } else if (row.type === "node_retry") {
      message = `第 ${payload.attempt ?? "?"} 次执行失败：${
        payload.error ?? "未知错误"
      }，准备第 ${Number(payload.attempt ?? 0) + 1} 次尝试`;
      level = "warning";
    } else if (row.type === "approval_decided") {
      const roundLabel = payload.round ? `第 ${payload.round} 轮` : "";
      if (payload.decision === "revise") {
        message = `人工审核要求修改${roundLabel ? `（${roundLabel}）` : ""}${payload.note ? `：${payload.note}` : ""}`;
        level = "info";
      } else if (payload.decision === "approve") {
        message = `人工审核通过${payload.note ? `：${payload.note}` : ""}`;
        level = "info";
      } else {
        message = `人工审核驳回${payload.note ? `：${payload.note}` : ""}`;
        level = "warning";
      }
    }
    if (message) {
      notices.push({
        type: row.type,
        level,
        message,
        createdAt: row.created_at,
      });
    }
  }
  return notices;
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

/** 标记应用退出时仍处于活动状态的运行为中断（进程已不存在，不能假装还在跑） */
export function interruptStaleWorkflowRuns(): void {
  const now = Date.now();

  // 触发器启动的运行被异常中断时，也把原因回写到触发器卡片
  const staleTriggerIds = db!
    .prepare(
      "SELECT DISTINCT trigger_id FROM workflow_runs WHERE status IN ('running','awaiting_approval') AND source = 'trigger' AND trigger_id IS NOT NULL",
    )
    .all() as { trigger_id: string }[];
  for (const row of staleTriggerIds) {
    prepare(
      "UPDATE workflow_triggers SET last_error = ?, updated_at = ? WHERE id = ?",
    ).run("应用异常退出，运行被中断", now, row.trigger_id);
  }

  prepare(
    "UPDATE workflow_runs SET status = 'interrupted', error = '应用已退出，运行被中断', finished_at = ? WHERE status IN ('running','awaiting_approval')",
  ).run(now);
  prepare(
    "UPDATE workflow_node_runs SET status = 'canceled', finished_at = ? WHERE status IN ('pending','running','awaiting_approval','retrying')",
  ).run(now);
}

// ============================================================================
// 设置操作
// ============================================================================

export function getSetting(key: string): string | null {
  const row = prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
  ).run(key, value, value);
}

// ============================================================================
// 自动化任务操作
// ============================================================================

export function listAutomationTasks(): AutomationTask[] {
  const rows = prepare("SELECT * FROM automation_tasks ORDER BY created_at DESC").all() as any[];
  return rows.map(rowToAutomationTask);
}

export function getAutomationTask(id: string): AutomationTask | null {
  const row = prepare("SELECT * FROM automation_tasks WHERE id = ?").get(id) as any;
  return row ? rowToAutomationTask(row) : null;
}

export function createAutomationTask(prompt: string, projectId: string, agentId: string): AutomationTask {
  const id = randomUUID();
  const now = Date.now();
  prepare(
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
  prepare(`UPDATE automation_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function deleteAutomationTask(id: string): void {
  prepare("DELETE FROM automation_tasks WHERE id = ?").run(id);
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

// ============================================================================
// 待办事项
// ============================================================================

function rowToTodo(row: any): TodoItem {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags_json);
    if (Array.isArray(parsed)) {
      tags = parsed.filter((tag): tag is string => typeof tag === "string");
    }
  } catch {
    // 损坏的标签按空数组处理，不影响条目本身
  }
  const priority: TodoPriority =
    row.priority === "high" || row.priority === "low" ? row.priority : "normal";
  return {
    id: row.id,
    title: row.title,
    note: row.note ?? "",
    priority,
    dueAt: row.due_at ?? null,
    tags,
    done: row.done === 1,
    completedAt: row.completed_at ?? null,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listTodos(): TodoItem[] {
  const rows = db!
    .prepare("SELECT * FROM todos ORDER BY sort_order ASC, created_at DESC")
    .all() as any[];
  return rows.map(rowToTodo);
}

export function getTodo(id: string): TodoItem | null {
  const row = prepare("SELECT * FROM todos WHERE id = ?").get(id) as any;
  return row ? rowToTodo(row) : null;
}

export function createTodo(draft: TodoDraft): TodoItem {
  const id = randomUUID();
  const now = Date.now();
  // 新条目排在最前面：取全局最小 sort_order 再减一。
  // 分组展示时，各组的相对顺序仍由各自的 sort_order 决定。
  const min = prepare("SELECT MIN(sort_order) AS value FROM todos").get() as {
    value: number | null;
  };
  const sortOrder = (min.value ?? 0) - 1;

  prepare(
    "INSERT INTO todos (id, title, note, priority, due_at, tags_json, done, completed_at, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)",
  ).run(
    id,
    draft.title,
    draft.note,
    draft.priority,
    draft.dueAt,
    JSON.stringify(draft.tags),
    sortOrder,
    now,
    now,
  );
  return getTodo(id)!;
}

export function updateTodo(id: string, draft: TodoDraft): TodoItem | null {
  const info = db!
    .prepare(
      "UPDATE todos SET title = ?, note = ?, priority = ?, due_at = ?, tags_json = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      draft.title,
      draft.note,
      draft.priority,
      draft.dueAt,
      JSON.stringify(draft.tags),
      Date.now(),
      id,
    );
  return info.changes > 0 ? getTodo(id) : null;
}

/** 只切换完成状态，不要求前端回传整份草稿 */
export function setTodoDone(id: string, done: boolean): TodoItem | null {
  const info = db!
    .prepare(
      "UPDATE todos SET done = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(done ? 1 : 0, done ? Date.now() : null, Date.now(), id);
  return info.changes > 0 ? getTodo(id) : null;
}

export function deleteTodo(id: string): boolean {
  return prepare("DELETE FROM todos WHERE id = ?").run(id).changes > 0;
}

export function clearCompletedTodos(): number {
  return prepare("DELETE FROM todos WHERE done = 1").run().changes;
}

/**
 * 按传入顺序重写 sort_order。
 * 调用方只传同一分组内的 id，组与组之间的排序值互不影响。
 */
export function reorderTodos(ids: string[]): boolean {
  const now = Date.now();
  const stmt = prepare("UPDATE todos SET sort_order = ?, updated_at = ? WHERE id = ?");
  db!.transaction(() => {
    ids.forEach((id, index) => stmt.run(index, now, id));
  })();
  return true;
}

export function countPendingTodos(): number {
  const row = db!
    .prepare("SELECT COUNT(*) AS value FROM todos WHERE done = 0")
    .get() as { value: number };
  return row.value;
}

// ============================================================================
// 提示词
// ============================================================================

/**
 * tags_json 列仍保留在表里（历史数据不丢），但界面已移除标签功能，
 * 因此不再读取，也不再写入。
 */
function rowToPrompt(row: any): PromptItem {
  return {
    id: row.id,
    title: row.title,
    content: row.content ?? "",
    favorite: row.favorite === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 按最近修改排序。
 *
 * favorite 列仍保留在表里（历史数据不丢），但界面已移除收藏功能，
 * 因此不再参与排序 —— 否则旧收藏会毫无提示地钉在列表顶部。
 */
export function listPrompts(): PromptItem[] {
  const rows = db!
    .prepare("SELECT * FROM prompts ORDER BY updated_at DESC, rowid DESC")
    .all() as any[];
  return rows.map(rowToPrompt);
}

export function getPrompt(id: string): PromptItem | null {
  const row = prepare("SELECT * FROM prompts WHERE id = ?").get(id) as any;
  return row ? rowToPrompt(row) : null;
}

export function createPrompt(draft: PromptDraft): PromptItem {
  const id = randomUUID();
  const now = Date.now();
  prepare(
    "INSERT INTO prompts (id, title, content, favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, draft.title, draft.content, draft.favorite ? 1 : 0, now, now);
  return getPrompt(id)!;
}

export function updatePrompt(id: string, draft: PromptDraft): PromptItem | null {
  const info = db!
    .prepare(
      "UPDATE prompts SET title = ?, content = ?, favorite = ?, updated_at = ? WHERE id = ?",
    )
    .run(draft.title, draft.content, draft.favorite ? 1 : 0, Date.now(), id);
  return info.changes > 0 ? getPrompt(id) : null;
}

export function deletePrompt(id: string): boolean {
  return prepare("DELETE FROM prompts WHERE id = ?").run(id).changes > 0;
}

/** 关闭数据库 */
export function closeDatabase(): void {
  clearStmtCache();
  db?.close();
}
