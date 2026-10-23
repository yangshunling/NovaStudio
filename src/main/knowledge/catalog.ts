/**
 * 知识库资产目录
 *
 * 与 Skill / MCP 同构：磁盘目录是唯一事实来源。
 * - 每个知识库 = ~/.novastudio/knowledge/<slug>/，元信息存目录内 .kb.json
 * - 只收 Markdown（.md / .markdown），其他格式在上传时直接拒绝
 * - 全文索引落在 SQLite FTS5（trigram），磁盘删除 / 外部修改会在检索前自动同步
 *
 * 本模块只负责扫描、文件 CRUD 与索引同步；运行时如何注入给数字员工
 * 在 knowledge/runtime.ts，IPC 选择框在 ipc/handlers/knowledge.ts。
 */

import { existsSync } from "fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { basename, extname, join, relative, resolve, sep } from "path";
import {
  deleteKnowledgeDocument,
  deleteKnowledgeDocumentsByKb,
  getKnowledgeIndexMeta,
  searchKnowledgeDocuments,
  upsertKnowledgeDocument,
} from "../db/sqlite";
import { DATA_DIR } from "../utils/paths";
import type {
  KnowledgeBaseAsset,
  KnowledgeDocument,
  KnowledgeDocumentContent,
  KnowledgeSearchResult,
  KnowledgeUploadResult,
  KnowledgeWriteResult,
} from "../../shared/types";

/** Nova 知识库根目录 */
export const KNOWLEDGE_ROOT = join(DATA_DIR, "knowledge");

/** 知识库元信息文件名（UI 不展示） */
const META_FILE = ".kb.json";

/** 单文件上限：100MB */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** 进入全文索引的内容上限；更大的文件仍可浏览 / 注入，但检索只按文件名 */
const INDEX_MAX_BYTES = 8 * 1024 * 1024;

/** 预览抽屉读取上限 */
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** 单个知识库的扫描 / 检索上限，避免异常目录拖垮主进程 */
const MAX_SCAN_FILES = 5000;
const MAX_SCAN_DEPTH = 12;
const SEARCH_LIMIT = 50;

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

interface KnowledgeMeta {
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

interface ScanResult {
  documents: KnowledgeDocument[];
  documentCount: number;
  totalBytes: number;
  latestUpdatedAt: number;
}

function isMarkdown(fileName: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

// ============================================================================
// 路径安全
// ============================================================================

/**
 * 相对路径 → 绝对路径。
 *
 * 只接受知识库内部的相对路径：拒绝 `..`、绝对路径与空段落，
 * 避免 IPC 参数构造出越界读写。
 */
function resolveRelative(root: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return resolve(root);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return null;
  }

  const rootAbs = resolve(root);
  const target = resolve(rootAbs, normalized);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null;
  return target;
}

/** 真实路径必须仍在知识库内：防止符号链接 / junction 把操作带出根目录 */
async function isInsideReal(root: string, target: string): Promise<boolean> {
  try {
    const realRoot = await realpath(root);
    const realTarget = await realpath(target);
    return (
      realTarget === realRoot || realTarget.startsWith(realRoot + sep)
    );
  } catch {
    return false;
  }
}

// ============================================================================
// 扫描
// ============================================================================

async function readMeta(
  dir: string,
  fallbackName: string,
  fallbackTime: number,
): Promise<KnowledgeMeta> {
  try {
    const raw = await readFile(join(dir, META_FILE), "utf8");
    const value = JSON.parse(raw) as Partial<KnowledgeMeta>;
    return {
      name:
        typeof value.name === "string" && value.name.trim()
          ? value.name.trim()
          : fallbackName,
      description:
        typeof value.description === "string" ? value.description : "",
      createdAt:
        typeof value.createdAt === "number" ? value.createdAt : fallbackTime,
      updatedAt:
        typeof value.updatedAt === "number" ? value.updatedAt : fallbackTime,
    };
  } catch {
    return {
      name: fallbackName,
      description: "",
      createdAt: fallbackTime,
      updatedAt: fallbackTime,
    };
  }
}

/** 递归收集 Markdown 文档；跳过隐藏项、符号链接与非 Markdown 文件 */
async function scanDocuments(root: string): Promise<ScanResult> {
  const documents: KnowledgeDocument[] = [];
  let totalBytes = 0;
  let latestUpdatedAt = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || documents.length >= MAX_SCAN_FILES) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (documents.length >= MAX_SCAN_FILES) return;
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isMarkdown(entry.name)) continue;

      try {
        const info = await stat(full);
        documents.push({
          name: entry.name,
          relativePath: toPosix(relative(root, full)),
          isDirectory: false,
          size: info.size,
          updatedAt: info.mtimeMs,
          indexed: info.size <= INDEX_MAX_BYTES,
        });
        totalBytes += info.size;
        latestUpdatedAt = Math.max(latestUpdatedAt, info.mtimeMs);
      } catch {
        // 无权限 / 文件被占用：跳过，不影响其它文档
      }
    }
  };

  await walk(root, 0);
  return {
    documents,
    documentCount: documents.length,
    totalBytes,
    latestUpdatedAt,
  };
}

function toAsset(
  slug: string,
  dir: string,
  meta: KnowledgeMeta,
  scan: ScanResult,
): KnowledgeBaseAsset {
  return {
    id: `knowledge:${slug}`,
    slug,
    name: meta.name,
    description: meta.description,
    path: dir,
    documentCount: scan.documentCount,
    totalBytes: scan.totalBytes,
    updatedAt: Math.max(meta.updatedAt, scan.latestUpdatedAt),
  };
}

export async function listKnowledgeBases(): Promise<KnowledgeBaseAsset[]> {
  await mkdir(KNOWLEDGE_ROOT, { recursive: true });

  let entries;
  try {
    entries = await readdir(KNOWLEDGE_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: KnowledgeBaseAsset[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(KNOWLEDGE_ROOT, entry.name);
    try {
      const info = await stat(dir);
      const meta = await readMeta(dir, entry.name, info.mtimeMs);
      const scan = await scanDocuments(dir);
      result.push(toAsset(entry.name, dir, meta, scan));
    } catch {
      // 单个知识库损坏不影响其它条目
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export async function getKnowledgeBase(
  id: string,
): Promise<KnowledgeBaseAsset | null> {
  return (await listKnowledgeBases()).find((asset) => asset.id === id) ?? null;
}

/** 运行时使用：递归列出某个知识库的全部 Markdown 相对路径 */
export async function listKnowledgeFiles(id: string): Promise<string[]> {
  const asset = await getKnowledgeBase(id);
  if (!asset) return [];
  const scan = await scanDocuments(asset.path);
  return scan.documents.map((document) => document.relativePath);
}

/** 单层目录列表：供右侧文档表格使用 */
export async function listKnowledgeDocuments(
  id: string,
  subPath = "",
): Promise<KnowledgeDocument[]> {
  const asset = await getKnowledgeBase(id);
  if (!asset) return [];

  const dir = resolveRelative(asset.path, subPath);
  if (!dir) return [];
  if (!(await isInsideReal(asset.path, dir))) return [];

  let entries;
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return [];
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const documents: KnowledgeDocument[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) continue;

    const full = join(dir, entry.name);
    const relativePath = toPosix(relative(asset.path, full));

    if (entry.isDirectory()) {
      documents.push({
        name: entry.name,
        relativePath,
        isDirectory: true,
        size: 0,
        updatedAt: 0,
        indexed: true,
      });
      continue;
    }

    if (!entry.isFile() || !isMarkdown(entry.name)) continue;

    try {
      const info = await stat(full);
      documents.push({
        name: entry.name,
        relativePath,
        isDirectory: false,
        size: info.size,
        updatedAt: info.mtimeMs,
        indexed: info.size <= INDEX_MAX_BYTES,
      });
    } catch {
      // 忽略读不到的文件
    }
  }

  return documents.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
}

// ============================================================================
// 新建 / 更新 / 删除
// ============================================================================

/** 校验展示名；返回错误文案，合法时返回 null */
function validateName(name: string): string | null {
  if (!name.trim()) return "名称不能为空";
  if (name.trim().length > 80) return "名称不能超过 80 个字符";
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    return "名称不能包含 \\ / : * ? \" < > | 等字符";
  }
  return null;
}

/** 展示名 → 目录名：保留中文，替换 Windows 非法字符 */
function toFolderName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
  if (!cleaned) return `kb-${Date.now().toString(36)}`;
  // Windows 保留设备名
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
    return `kb-${cleaned}`;
  }
  return cleaned;
}

function uniqueFolderName(base: string): string {
  let name = base;
  let index = 2;
  while (existsSync(join(KNOWLEDGE_ROOT, name))) {
    name = `${base}-${index}`;
    index += 1;
  }
  return name;
}

export async function createKnowledgeBase(
  name: string,
  description: string,
): Promise<KnowledgeWriteResult> {
  const trimmed = name.trim();
  const invalid = validateName(trimmed);
  if (invalid) return { ok: false, error: invalid };

  const existing = await listKnowledgeBases();
  if (
    existing.some(
      (asset) => asset.name.toLowerCase() === trimmed.toLowerCase(),
    )
  ) {
    return { ok: false, error: `已存在同名知识库：${trimmed}` };
  }

  try {
    await mkdir(KNOWLEDGE_ROOT, { recursive: true });
    const slug = uniqueFolderName(toFolderName(trimmed));
    const dir = join(KNOWLEDGE_ROOT, slug);
    await mkdir(dir, { recursive: true });

    const now = Date.now();
    const meta: KnowledgeMeta = {
      name: trimmed,
      description: description.trim(),
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(
      join(dir, META_FILE),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf8",
    );

    return {
      ok: true,
      asset: toAsset(slug, dir, meta, {
        documents: [],
        documentCount: 0,
        totalBytes: 0,
        latestUpdatedAt: 0,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function updateKnowledgeBase(
  id: string,
  name: string,
  description: string,
): Promise<KnowledgeWriteResult> {
  const asset = await getKnowledgeBase(id);
  if (!asset) return { ok: false, error: "知识库不存在，可能已被删除" };

  const trimmed = name.trim();
  const invalid = validateName(trimmed);
  if (invalid) return { ok: false, error: invalid };

  const duplicate = (await listKnowledgeBases()).find(
    (item) =>
      item.id !== id && item.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (duplicate) {
    return { ok: false, error: `已存在同名知识库：${trimmed}` };
  }

  try {
    const current = await readMeta(asset.path, asset.slug, asset.updatedAt);
    const meta: KnowledgeMeta = {
      ...current,
      name: trimmed,
      description: description.trim(),
      updatedAt: Date.now(),
    };
    await writeFile(
      join(asset.path, META_FILE),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf8",
    );

    return { ok: true, asset: { ...asset, ...meta } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteKnowledgeBase(id: string): Promise<boolean> {
  const asset = await getKnowledgeBase(id);
  if (!asset) return false;
  try {
    await rm(asset.path, { recursive: true, force: true });
    deleteKnowledgeDocumentsByKb(id);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// 文件夹与文档
// ============================================================================

export async function createKnowledgeFolder(
  id: string,
  parentPath: string,
  name: string,
): Promise<boolean> {
  const asset = await getKnowledgeBase(id);
  if (!asset) return false;

  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed.startsWith(".") ||
    trimmed.length > 80 ||
    /[\\/:*?"<>|\u0000-\u001f]/.test(trimmed)
  ) {
    return false;
  }

  const parent = resolveRelative(asset.path, parentPath);
  if (!parent || !(await isInsideReal(asset.path, parent))) return false;

  const folderName = toFolderName(trimmed);
  const target = join(parent, folderName);

  try {
    const info = await stat(parent);
    if (!info.isDirectory()) return false;
    if (existsSync(target)) return false;
    await mkdir(target, { recursive: false });
    return true;
  } catch {
    return false;
  }
}

/** 同名文件自动加 (2)、(3)……避免覆盖用户已有资料 */
function uniqueFileName(
  originalName: string,
  used: Set<string>,
): string {
  const ext = extname(originalName);
  const base = basename(originalName, ext);
  let candidate = originalName;
  let index = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} (${index})${ext}`;
    index += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

async function indexDocument(
  asset: KnowledgeBaseAsset,
  document: KnowledgeDocument,
): Promise<void> {
  const absolute = join(asset.path, document.relativePath);

  if (!document.indexed) {
    deleteKnowledgeDocument(asset.id, document.relativePath);
    return;
  }

  try {
    const content = await readFile(absolute, "utf8");
    upsertKnowledgeDocument({
      kbId: asset.id,
      relativePath: document.relativePath,
      name: document.name,
      size: document.size,
      updatedAt: Math.floor(document.updatedAt),
      content,
    });
  } catch {
    // 索引失败不影响文件本身；下次检索同步时会重试
  }
}

/**
 * 把若干外部文件复制进知识库的当前文件夹。
 * 只接受 Markdown；同名自动改名；部分失败时通过 warnings 返回。
 */
export async function importKnowledgeFiles(
  id: string,
  parentPath: string,
  filePaths: string[],
): Promise<KnowledgeUploadResult> {
  const asset = await getKnowledgeBase(id);
  if (!asset) {
    return { ok: false, uploaded: [], warnings: [], error: "知识库不存在，可能已被删除" };
  }

  const parent = resolveRelative(asset.path, parentPath);
  if (!parent || !(await isInsideReal(asset.path, parent))) {
    return { ok: false, uploaded: [], warnings: [], error: "目标文件夹不在知识库内" };
  }

  let existingNames: string[] = [];
  try {
    existingNames = (await readdir(parent)).map((name) => name.toLowerCase());
  } catch {
    return { ok: false, uploaded: [], warnings: [], error: "目标文件夹不存在" };
  }
  const used = new Set(existingNames);

  const uploaded: KnowledgeDocument[] = [];
  const warnings: string[] = [];

  for (const source of filePaths) {
    const sourceName = basename(source);

    if (!isMarkdown(sourceName)) {
      warnings.push(`${sourceName}：只支持 Markdown（.md / .markdown）`);
      continue;
    }

    try {
      const info = await stat(source);
      if (!info.isFile()) {
        warnings.push(`${sourceName}：不是文件`);
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        warnings.push(`${sourceName}：超过 100MB 上限`);
        continue;
      }

      const targetName = uniqueFileName(sourceName, used);
      if (targetName !== sourceName) {
        warnings.push(`${sourceName}：存在同名文件，已保存为 ${targetName}`);
      }

      const target = join(parent, targetName);
      await copyFile(source, target);

      const copied = await stat(target);
      const document: KnowledgeDocument = {
        name: targetName,
        relativePath: toPosix(relative(asset.path, target)),
        isDirectory: false,
        size: copied.size,
        updatedAt: copied.mtimeMs,
        indexed: copied.size <= INDEX_MAX_BYTES,
      };
      uploaded.push(document);
      await indexDocument(asset, document);
    } catch (err) {
      warnings.push(
        `${sourceName}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (uploaded.length === 0) {
    return {
      ok: false,
      uploaded,
      warnings,
      error: warnings.join("；") || "没有可上传的 Markdown 文件",
    };
  }

  return { ok: true, uploaded, warnings };
}

async function collectDocumentPaths(
  asset: KnowledgeBaseAsset,
  target: string,
): Promise<KnowledgeDocument[]> {
  const info = await stat(target);
  if (!info.isDirectory()) {
    return [
      {
        name: basename(target),
        relativePath: toPosix(relative(asset.path, target)),
        isDirectory: false,
        size: info.size,
        updatedAt: info.mtimeMs,
        indexed: info.size <= INDEX_MAX_BYTES,
      },
    ];
  }
  return (await scanDocuments(target)).documents.map((document) => ({
    ...document,
    relativePath: toPosix(relative(asset.path, join(target, document.relativePath))),
  }));
}

export async function deleteKnowledgeDocuments(
  id: string,
  paths: string[],
): Promise<boolean> {
  const asset = await getKnowledgeBase(id);
  if (!asset || paths.length === 0) return false;

  let ok = true;
  for (const relativePath of paths) {
    const target = resolveRelative(asset.path, relativePath);
    // 根目录本身不允许删除
    if (!target || target === resolve(asset.path)) {
      ok = false;
      continue;
    }
    if (!(await isInsideReal(asset.path, target))) {
      ok = false;
      continue;
    }

    try {
      const documents = await collectDocumentPaths(asset, target);
      await rm(target, { recursive: true, force: true });
      for (const document of documents) {
        deleteKnowledgeDocument(asset.id, document.relativePath);
      }
    } catch {
      ok = false;
    }
  }
  return ok;
}

// ============================================================================
// 预览
// ============================================================================

export async function readKnowledgeDocument(
  id: string,
  relativePath: string,
): Promise<KnowledgeDocumentContent | null> {
  const asset = await getKnowledgeBase(id);
  if (!asset) return null;

  const target = resolveRelative(asset.path, relativePath);
  if (!target || !(await isInsideReal(asset.path, target))) return null;

  try {
    const info = await stat(target);
    if (!info.isFile() || !isMarkdown(target)) return null;

    const length = Math.min(info.size, PREVIEW_MAX_BYTES);
    const handle = await open(target, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      return {
        content: buffer.toString("utf8"),
        size: info.size,
        updatedAt: info.mtimeMs,
        truncated: info.size > PREVIEW_MAX_BYTES,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** 返回文档的绝对路径；供「用系统程序打开」使用 */
export async function resolveDocumentPath(
  id: string,
  relativePath: string,
): Promise<string | null> {
  const asset = await getKnowledgeBase(id);
  if (!asset) return null;
  const target = resolveRelative(asset.path, relativePath);
  if (!target || !(await isInsideReal(asset.path, target))) return null;
  return target;
}

// ============================================================================
// 全文检索
// ============================================================================

/**
 * 把磁盘状态同步到索引。
 *
 * 只读取 mtime / size 发生变化的文件；外部新增、修改、删除 Markdown
 * 都会在下一次检索时被吸收。超过 INDEX_MAX_BYTES 的文件不建索引。
 */
export async function syncKnowledgeIndex(kbId?: string): Promise<void> {
  const assets = await listKnowledgeBases();
  const targets = kbId
    ? assets.filter((asset) => asset.id === kbId)
    : assets;

  for (const asset of targets) {
    const scan = await scanDocuments(asset.path);
    const indexed = new Map(
      getKnowledgeIndexMeta(asset.id).map((meta) => [meta.relativePath, meta]),
    );
    const alive = new Set<string>();

    for (const document of scan.documents) {
      alive.add(document.relativePath);

      if (!document.indexed) {
        if (indexed.has(document.relativePath)) {
          deleteKnowledgeDocument(asset.id, document.relativePath);
        }
        continue;
      }

      const previous = indexed.get(document.relativePath);
      if (
        previous &&
        previous.size === document.size &&
        Math.floor(previous.updatedAt) === Math.floor(document.updatedAt)
      ) {
        continue;
      }
      await indexDocument(asset, document);
    }

    // 磁盘上已不存在的文档，同步删除索引
    for (const path of indexed.keys()) {
      if (!alive.has(path)) deleteKnowledgeDocument(asset.id, path);
    }
  }
}

export async function searchKnowledge(
  query: string,
  kbId?: string,
): Promise<KnowledgeSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { hits: [], total: 0, query: trimmed, degraded: false };
  }

  await syncKnowledgeIndex(kbId);

  const assets = await listKnowledgeBases();
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const { rows, degraded } = searchKnowledgeDocuments({
    query: trimmed,
    kbId,
    limit: SEARCH_LIMIT,
  });

  const hits = rows
    .filter((row) => byId.has(row.kbId))
    .map((row) => ({
      kbId: row.kbId,
      kbName: byId.get(row.kbId)!.name,
      relativePath: row.relativePath,
      snippet: row.snippet,
    }));

  return {
    hits,
    total: hits.length,
    query: trimmed,
    degraded,
  };
}
