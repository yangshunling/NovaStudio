/**
 * SQLite 持久化（统一出口）
 *
 * 使用 better-sqlite3 同步 API（N-API，ABI 稳定，Electron 下无需 rebuild）。
 *
 * 结构：
 * - connection.ts        连接生命周期 + prepared statement 缓存
 * - schema.ts            建表、旧库重建、幂等补列、FTS 初始化
 * - fts-state.ts         知识库 FTS 可用性标记
 * - repositories/*.ts    按领域拆分的 SQL 与行映射
 *
 * 本文件只做 re-export，保持既有 `import * as db from "../db/sqlite"`
 * 调用点不变；新增查询请落到对应 repository，而不是继续堆在这里。
 */

export { closeDatabase } from "./connection";
export { initDatabase } from "./schema";

export * from "./repositories/projects";
export * from "./repositories/sessions";
export * from "./repositories/employees";
export * from "./repositories/knowledge";
export * from "./repositories/workflows";
export * from "./repositories/triggers";
export * from "./repositories/workflow-runs";
export * from "./repositories/settings";
export * from "./repositories/automation";
export * from "./repositories/todos";
export * from "./repositories/prompts";
