/**
 * 知识库全文索引（SQLite repository）
 *
 * 只包含该领域的 SQL 与行映射；连接与语句缓存见 ../connection。
 */

import { getDb, prepare } from "../connection";
import { isKnowledgeFtsReady } from "../fts-state";

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
  const rows = getDb()
    .prepare(
      `SELECT relative_path AS relativePath, size, updated_at AS updatedAt
       FROM knowledge_documents WHERE kb_id = ?`,
    )
    .all(kbId) as KnowledgeIndexMeta[];
  return rows;
}

/** 写入 / 更新一个文档的索引（external content FTS 需要手动同步删除旧行） */
/** 短词 LIKE 只扫正文前 8KB，避免大文档全表扫描 */
const EXCERPT_CHARS = 8192;

export function upsertKnowledgeDocument(input: {
  kbId: string;
  relativePath: string;
  name: string;
  size: number;
  updatedAt: number;
  content: string;
}): void {
  const existing = getDb()
    .prepare(
      "SELECT id, content FROM knowledge_documents WHERE kb_id = ? AND relative_path = ?",
    )
    .get(input.kbId, input.relativePath) as
    | { id: number; content: string }
    | undefined;

  const tx = getDb().transaction(() => {
    if (existing) {
      if (isKnowledgeFtsReady()) {
        getDb()
          .prepare(
            "INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES ('delete', ?, ?)",
          )
          .run(existing.id, existing.content);
      }
      getDb()
        .prepare(
          `UPDATE knowledge_documents
           SET name = ?, size = ?, updated_at = ?, content = ?, content_excerpt = ?
           WHERE id = ?`,
        )
        .run(
          input.name,
          input.size,
          input.updatedAt,
          input.content,
          input.content.slice(0, EXCERPT_CHARS),
          existing.id,
        );
      if (isKnowledgeFtsReady()) {
        getDb()
          .prepare("INSERT INTO knowledge_fts(rowid, content) VALUES (?, ?)")
          .run(existing.id, input.content);
      }
      return;
    }

    const info = getDb()
      .prepare(
        `INSERT INTO knowledge_documents
         (kb_id, relative_path, name, size, updated_at, content, content_excerpt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kbId,
        input.relativePath,
        input.name,
        input.size,
        input.updatedAt,
        input.content,
        input.content.slice(0, EXCERPT_CHARS),
      );
    if (isKnowledgeFtsReady()) {
      getDb()
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
  const row = getDb()
    .prepare(
      "SELECT id, content FROM knowledge_documents WHERE kb_id = ? AND relative_path = ?",
    )
    .get(kbId, relativePath) as { id: number; content: string } | undefined;
  if (!row) return;

  getDb().transaction(() => {
    if (isKnowledgeFtsReady()) {
      getDb()
        .prepare(
          "INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES ('delete', ?, ?)",
        )
        .run(row.id, row.content);
    }
    prepare("DELETE FROM knowledge_documents WHERE id = ?").run(row.id);
  })();
}

export function deleteKnowledgeDocumentsByKb(kbId: string): void {
  const rows = getDb()
    .prepare("SELECT id, content FROM knowledge_documents WHERE kb_id = ?")
    .all(kbId) as { id: number; content: string }[];

  getDb().transaction(() => {
    if (isKnowledgeFtsReady()) {
      const del = prepare(
        "INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES ('delete', ?, ?)",
      );
      for (const row of rows) del.run(row.id, row.content);
    }
    prepare("DELETE FROM knowledge_documents WHERE kb_id = ?").run(kbId);
  })();
}

/** 把查询拆成检索词；空查询返回空数组 */
/**
 * 检索词上限。
 *
 * LIKE 降级路径按「每个词一个 `content_excerpt LIKE ?`」拼 SQL，词数直接等于
 * 绑定变量数；SQLite 默认上限是 999（旧版更小），超长查询会把变量名额打穿，
 * 搜索直接抛错。正常查询十几个词已经远超需要，多的丢掉不影响召回。
 */
const MAX_SEARCH_TERMS = 16;
/** 查询串长度上限：避免粘贴整篇文档当检索词 */
const MAX_QUERY_LENGTH = 200;

function splitSearchTerms(query: string): string[] {
  return query
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TERMS);
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

  if (isKnowledgeFtsReady() && allLongEnough) {
    const match = terms
      .map((term) => `"${term.replace(/"/g, '""')}"`)
      .join(" AND ");
    const scope = input.kbId ? " AND d.kb_id = ?" : "";
    try {
      const rows = getDb()
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

  // 只匹配前 8KB 摘要，完整正文仍用于命中后的 snippet 展示
  const conditions = terms.map(() => "content_excerpt LIKE ? ESCAPE '\\'");
  if (input.kbId) conditions.push("kb_id = ?");
  const values: unknown[] = terms.map((term) => `%${escapeLike(term)}%`);
  if (input.kbId) values.push(input.kbId);
  values.push(input.limit);

  const rows = getDb()
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

