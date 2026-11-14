/**
 * 数据库 schema 与初始化
 *
 * 建表、旧库重建、幂等补列与 FTS 初始化集中在本文件；
 * 业务查询全部在 repositories/ 下，按领域拆分。
 */

import { existsSync, renameSync } from "fs";
import type Database from "better-sqlite3";
import { DB_PATH, ensureDataDirs } from "../utils/paths";
import { closeDatabase, getDb, openDatabase } from "./connection";
import { setKnowledgeFtsReady } from "./fts-state";
import { interruptStaleWorkflowRuns } from "./repositories/workflow-runs";

const SCHEMA_VERSION = 1;

/**
 * 发版前的旧库没有版本号（user_version = 0），结构可能与本版本的建表语句不一致，
 * 而 CREATE TABLE IF NOT EXISTS 会静默跳过已有表，导致后续查询缺列。
 * 这里把旧库文件改名备份后按当前 schema 重建，避免半新半旧的结构共存。
 */
function resetLegacyDatabase(): void {
  const version = getDb().pragma("user_version", { simple: true }) as number;
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本 ${version} 高于当前应用支持的 ${SCHEMA_VERSION}`,
    );
  }

  // 全新安装：文件里没有任何表，直接按建表语句初始化
  const hasTables = getDb()
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
    )
    .get();
  if (!hasTables) return;

  const backup = `${DB_PATH}.bak-${Date.now()}`;
  closeDatabase();
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
  const conn = getDb();

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
      -- 会话级权限模式；NULL 表示沿用 Agent 配置的默认值
      permission_mode TEXT,
      -- 会话级模型覆盖（完整 ID）；NULL 表示沿用 Agent 配置的默认模型
      model TEXT,
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
      -- 指定执行任务的数字员工；NULL 表示通用助手（Agent 全局配置）
      employee_id TEXT,
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
  ensureColumn(conn, "sessions", "permission_mode", "TEXT");
  ensureColumn(conn, "sessions", "model", "TEXT");
  ensureColumn(conn, "messages", "employee_id", "TEXT");
  // 自动化任务可指定执行任务的数字员工（旧库补列，历史任务保持通用助手）
  ensureColumn(conn, "automation_tasks", "employee_id", "TEXT");
  // 短词检索只扫前 8KB 摘要，避免对整篇正文做 LIKE
  ensureColumn(conn, "knowledge_documents", "content_excerpt", "TEXT NOT NULL DEFAULT ''");
  conn
    .prepare(
      "UPDATE knowledge_documents SET content_excerpt = substr(content, 1, 8192) WHERE content_excerpt = '' AND content <> ''",
    )
    .run();

  ensureKnowledgeFts();

  /*
   * 旧版本的自动化任务会话被记成了 chat，会混进会话列表。
   * 这里按任务表反查并改回 automation；之后新建的会话由调度器显式写入
   * 来源，不再依赖这一步。用 settings 里的标记保证只扫一次。
   */
  const sourceMigrationKey = "migratedAutomationSessionSource";
  const sourceMigrated = conn
    .prepare("SELECT 1 FROM settings WHERE key = ?")
    .get(sourceMigrationKey);
  if (!sourceMigrated) {
    conn
      .prepare(
        `UPDATE sessions SET source = 'automation'
         WHERE source = 'chat'
           AND id IN (
             SELECT session_id FROM automation_tasks WHERE session_id IS NOT NULL
           )`,
      )
      .run();
    conn
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')")
      .run(sourceMigrationKey);
  }

  // 上次进程遗留的运行不可能还活着：统一标记为中断
  interruptStaleWorkflowRuns();

  conn.exec(`
    -- 旧索引的谓词是 source <> 'workflow'，会把自动化会话也算进聊天列表，
    -- 因此必须删掉重建；仅改 CREATE 语句不会更新已存在的索引。
    DROP INDEX IF EXISTS idx_sessions_chat_updated;
    CREATE INDEX IF NOT EXISTS idx_sessions_chat_updated
      ON sessions (updated_at DESC) WHERE source = 'chat';
    CREATE INDEX IF NOT EXISTS idx_sessions_project
      ON sessions (project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_employee
      ON sessions (employee_id);
    -- 自动化任务详情 / 旧数据反查会话
    CREATE INDEX IF NOT EXISTS idx_automation_tasks_session
      ON automation_tasks (session_id);
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
  const exists = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_fts'")
    .get();
  try {
    if (!exists) {
      getDb().exec(`
        CREATE VIRTUAL TABLE knowledge_fts USING fts5(
          content,
          content='knowledge_documents',
          content_rowid='id',
          tokenize='trigram'
        );
      `);
      // 升级场景：文档表可能已有数据，创建索引后重建一次
      getDb().exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')");
    }
    setKnowledgeFtsReady(true);
  } catch {
    setKnowledgeFtsReady(false);
  }
}
