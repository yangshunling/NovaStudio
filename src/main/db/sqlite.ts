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
import type { Project, Session, Message, AutomationTask, AutomationStatus } from "../../shared/types";
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
  `);

  // === schema 迁移：只服务旧库 ===
  // 上面的 CREATE TABLE 已包含全部列，新装用户不会走到这里；
  // 旧库因表已存在而跳过 CREATE，故需要 ALTER 补齐后加的列。
  migrateSessionsProjectId();
  migrateSessionsMessageCount();

  // === 数据迁移：孤儿会话归入"收件箱"项目 ===
  migrateOrphanSessions();
}

/** 检测并给 sessions 表补 project_id 列 */
function migrateSessionsProjectId(): void {
  const cols = db!.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "project_id")) {
    db!.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT");
  }
}

/** 检测并给 sessions 表补 message_count 列（旧索引不含消息计数） */
function migrateSessionsMessageCount(): void {
  const cols = db!.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "message_count")) {
    db!.exec("ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0");
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
): Session {
  const id = randomUUID();
  const now = Date.now();
  const resolvedTitle = title || "新会话";

  db!.prepare(
    "INSERT INTO sessions (id, project_id, agent_id, agent_session_id, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, projectId, agentId, null, resolvedTitle, cwd, now, now);

  return {
    id,
    projectId,
    agentId,
    agentSessionId: null,
    title: resolvedTitle,
    cwd,
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
    agentId: row.agent_id,
    agentSessionId: row.agent_session_id,
    title: row.title,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count ?? 0,
    messages: [],
  };
}

/** 获取会话列表（按更新时间倒序） */
export function listSessions(): Session[] {
  const rows = db!.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as any[];
  return rows.map(rowToSession);
}

/**
 * 获取会话元数据。正文不入库——由 agent-service 调 provider 回放后填充 messages 字段。
 */
export function getSession(id: string): Session | null {
  const row = db!.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
  return row ? rowToSession(row) : null;
}

/** 列出某项目下所有会话 id（CLI 侧数据的清理由 agent-service 逐个执行） */
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
