/**
 * SQLite 连接与 statement 缓存
 *
 * 只负责“连接生命周期 + 语句复用”，不包含任何业务表知识。
 * repository 通过 `prepare()` 取语句，通过 `getDb()` 处理动态 SQL / 事务。
 */

import Database from "better-sqlite3";
import { DB_PATH } from "../utils/paths";

let db: Database.Database | null = null;

/**
 * prepared statement 缓存。
 *
 * better-sqlite3 的 prepare 每次都会编译 SQL；同一句 SQL 在不同函数里反复
 * prepare 意味着每条语句在每次调用时都重新编译。这里按 SQL 文本缓存复用，
 * 只在数据库关闭时清空。SQL 全是固定字面量，语句数量有界，缓存不会失控。
 */
const stmtCache = new Map<string, Database.Statement>();

/** 取当前连接；未初始化时直接报错，避免出现难以定位的空指针 */
export function getDb(): Database.Database {
  if (!db) throw new Error("数据库尚未初始化");
  return db;
}

/** prepare 的缓存包装：重复的 SQL 命中同一 Statement，避免反复编译 */
export function prepare(sql: string): Database.Statement {
  let statement = stmtCache.get(sql);
  if (!statement) {
    statement = getDb().prepare(sql);
    stmtCache.set(sql, statement);
  }
  return statement;
}

/** 数据库关闭后旧 statement 指向已关闭的连接，统一失效 */
export function clearStmtCache(): void {
  stmtCache.clear();
}

/** 打开连接并应用连接级 pragma（重建库后需要重新执行） */
export function openDatabase(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
}

/** 关闭数据库；重复调用无副作用 */
export function closeDatabase(): void {
  clearStmtCache();
  db?.close();
  db = null;
}
