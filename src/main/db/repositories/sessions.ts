/**
 * 会话与消息操作（SQLite repository）
 *
 * 只包含该领域的 SQL 与行映射；连接与语句缓存见 ../connection。
 */

import { randomUUID } from "crypto";
import { getDb, prepare } from "../connection";
import type { Message, Session, SessionSource } from "../../../shared/types";

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
  const rows = getDb()
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

/** 行 → 领域消息；单条损坏跳过，不影响其余历史 */
function parseMessageRows(rows: any[]): Message[] {
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
  return messages;
}

/**
 * 大消息延后一拍再序列化 / 落库。
 *
 * assistant 内容最大可达数 MB，`JSON.stringify` 是同步的；放到当前 IPC 批次
 * 结束后执行，避免回复收尾时和渲染层的事件处理挤在同一帧。
 */
export async function saveSessionMessageAsync(
  sessionId: string,
  msg: Message,
): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  saveSessionMessage(sessionId, msg);
}

/** 读取会话的全部持久化消息（按时间正序）。无数据时返回 null，表示回退到 provider 回放。 */
export function readSessionMessages(sessionId: string): Message[] | null {
  const rows = prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC",
  ).all(sessionId) as any[];
  if (rows.length === 0) return null;
  const messages = parseMessageRows(rows);
  return messages.length > 0 ? messages : null;
}

export interface SessionMessagePage {
  messages: Message[];
  hasMore: boolean;
}

/**
 * 分页读取最近 / 更早的消息。
 *
 * 先用 rowid 定位锚点再取前 N 条，避免同一毫秒内的消息在页边界被跳过。
 * 返回 null 表示本地没有任何消息（调用方可回退到 provider 历史）。
 */
export function readSessionMessagesPage(
  sessionId: string,
  input: {
    limit: number;
    beforeTimestamp?: number;
    beforeMessageId?: string;
  },
): SessionMessagePage | null {
  const limit = Math.max(1, Math.min(500, Math.round(input.limit)));
  const anchor = input.beforeMessageId
    ? (prepare("SELECT timestamp, rowid FROM messages WHERE id = ?").get(
        input.beforeMessageId,
      ) as { timestamp: number; rowid: number } | undefined)
    : undefined;

  const rows = anchor
    ? (prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND (timestamp < ? OR (timestamp = ? AND rowid < ?))
         ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      ).all(sessionId, anchor.timestamp, anchor.timestamp, anchor.rowid, limit + 1) as any[])
    : input.beforeTimestamp !== undefined
      ? (prepare(
          `SELECT * FROM messages
           WHERE session_id = ? AND timestamp < ?
           ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
        ).all(sessionId, input.beforeTimestamp, limit + 1) as any[])
      : (prepare(
          `SELECT * FROM messages
           WHERE session_id = ?
           ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
        ).all(sessionId, limit + 1) as any[]);

  if (rows.length === 0) return null;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return { messages: parseMessageRows(page), hasMore };
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
  getDb().transaction(() => {
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
  const rows = getDb()
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
  const rows = getDb()
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

