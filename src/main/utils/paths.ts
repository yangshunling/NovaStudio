/**
 * 路径管理
 *
 * 数据目录放在用户主目录下，与 app 安装目录物理隔离。
 * 卸载应用时数据不受影响。
 *
 * 对话正文不在此目录存储：由各 CLI（pi/claude/...）自行持久化到其
 * ~/.<agent>/ 会话目录，Nova 仅在 SQLite 索引中记录引用，回放时读取。
 */

import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

/** 数据根目录：~/.nova/ */
export const DATA_DIR = join(homedir(), ".nova");

/** SQLite 数据库路径 */
export const DB_PATH = join(DATA_DIR, "data.db");

/** 确保数据目录存在 */
export function ensureDataDirs(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}
