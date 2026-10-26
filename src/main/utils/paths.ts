/**
 * 路径管理
 *
 * 数据目录放在用户主目录下，与 app 安装目录物理隔离。
 * 卸载应用时数据不受影响。
 *
 * 对话正文不在此目录存储：由 CLI（Claude Code）自行持久化到其
 * ~/.claude/ 会话目录，Nova 仅在 SQLite 索引中记录引用，回放时读取。
 */

import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync, renameSync } from "fs";

/** 数据根目录：~/.novastudio/ */
export const DATA_DIR = join(homedir(), ".novastudio");

/** 旧版数据目录（仅一次性迁移用）：~/.nova/ */
const LEGACY_DATA_DIR = join(homedir(), ".nova");

/** SQLite 数据库路径 */
export const DB_PATH = join(DATA_DIR, "data.db");

/**
 * 确保数据目录存在。
 *
 * 一次性迁移：历史版本数据落在 ~/.nova/，首次启动新版时若检测到旧目录存在
 * 且新目录不存在，则整体移动（同盘原子操作，含 data.db、WAL、sessions 等
 * 全部内容）。新目录已存在则跳过，避免覆盖用户已有数据。
 */
export function ensureDataDirs(): void {
  if (existsSync(LEGACY_DATA_DIR) && !existsSync(DATA_DIR)) {
    renameSync(LEGACY_DATA_DIR, DATA_DIR);
  }
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}
