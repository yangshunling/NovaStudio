/**
 * 知识库 FTS 能力标记
 *
 * better-sqlite3 默认带 FTS5，但建表仍可能因环境差异失败。标记由 schema
 * 初始化时写入，知识库 repository 读取后决定走 FTS 还是 LIKE 降级。
 */

let ready = false;

export function setKnowledgeFtsReady(value: boolean): void {
  ready = value;
}

export function isKnowledgeFtsReady(): boolean {
  return ready;
}
