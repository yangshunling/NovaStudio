/**
 * 技能资产目录
 *
 * Nova 不再维护自己的技能主库。技能以磁盘目录为唯一事实来源：
 * - `~/.claude/skills`：Claude Code 全局技能目录，Nova 的新增/导入写到这里。
 *
 * 目录下的技能都可以在 Nova 中编辑、删除，保存时直接写回 SKILL.md。
 *
 * 运行时投影（按员工选择复制子集）在 agents/claude/prepare.ts，不放在资产层。
 */

import { existsSync } from "fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, extname, join } from "path";
import { isInsideReal, resolveInside } from "../utils/paths";
import {
  copyFilter,
  readTextFileLimited,
  writeTextFileLimited,
} from "../utils/fs";
import type {
  FileEntry,
  SkillAsset,
  SkillFileDocument,
  SkillImportKind,
  SkillImportResult,
  SkillOrigin,
  SkillWriteResult,
} from "../../shared/types";
import { errorMessage } from "../../shared/error";

/** Claude Code 全局技能目录：Nova 新增/导入的目标 */
function claudeSkillsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(configDir, "skills");
}

/** SKILL.md 读取上限，防止异常文件把渲染层拖垮 */
const DOCUMENT_LIMIT = 1_000_000;
/** 文件统计上限：技能目录通常很小，超过即停止，避免大仓库拖慢列表 */
const FILE_SCAN_LIMIT = 200;
const FILE_SCAN_DEPTH = 3;
/** 文件树上限：比统计更宽松，但避免异常目录把渲染层拖垮 */
const FILE_LIST_LIMIT = 500;
const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".rb",
  ".pl",
  ".lua",
]);

// ============================================================================
// 解析与扫描
// ============================================================================

/**
 * 极简 frontmatter 解析：只取 name / description。
 *
 * 支持 `key: value`、引号包裹，以及 `>` / `|` 多行块。
 * 技能 frontmatter 的字段很少，引入完整 YAML 解析器收益不大。
 */
function parseFrontmatter(raw: string): { name: string; description: string } {
  // 归一化行尾：CRLF 文件里 frontmatter 的最后一个字段会残留 \r，
  // 而 `.` 不匹配 \r，会让 `key: value` 的整行匹配失败。
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  // 允许 frontmatter 前有空白行（部分编辑器会保留）
  const start = text.indexOf("---");
  if (start < 0 || text.slice(0, start).trim() !== "") {
    return { name: "", description: "" };
  }

  const body = text.slice(start);
  const end = body.indexOf("\n---", 3);
  if (end < 0) return { name: "", description: "" };

  const lines = body.slice(3, end).split("\n");
  const fields: Record<string, string> = {};

  for (let i = 0; i < lines.length; i += 1) {
    // 兼容中文输入法误输入的全角冒号
    const match = /^([A-Za-z0-9_-]+)\s*[:：]\s*(.*)$/.exec(lines[i]);
    if (!match) continue;

    const key = match[1].toLowerCase();
    let value = match[2].trim();

    // `>` / `|` 及其 chomping 变体；允许行尾注释
    const indicator = value.split("#")[0].trim();
    if (/^[>|][+-]?$/.test(indicator)) {
      const folded = indicator.startsWith(">");
      const parts: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!/^\s+/.test(next) && next.trim() !== "") break;
        i += 1;
        parts.push(next.replace(/^\s+/, ""));
      }
      value = (folded ? parts.join(" ") : parts.join("\n")).trim();
    } else if (
      value === "" &&
      i + 1 < lines.length &&
      /^\s+\S/.test(lines[i + 1])
    ) {
      // 省略 `>` / `|` 的缩进续行（YAML plain scalar）
      const parts: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() === "") {
          i += 1;
          parts.push("");
          continue;
        }
        if (!/^\s+/.test(next)) break;
        i += 1;
        parts.push(next.replace(/^\s+/, ""));
      }
      value = parts.join(" ").trim();
    } else {
      value = value.replace(/^["']|["']$/g, "");
    }

    fields[key] = value;
  }

  return { name: fields.name ?? "", description: fields.description ?? "" };
}

/** 统计技能目录内的文件数与是否含脚本（有上限，不追求精确） */
async function scanContents(
  root: string,
): Promise<{ fileCount: number; hasScripts: boolean }> {
  let fileCount = 0;
  let hasScripts = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > FILE_SCAN_DEPTH || fileCount >= FILE_SCAN_LIMIT) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (fileCount >= FILE_SCAN_LIMIT) return;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".DS_Store") {
        continue;
      }

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }

      // 符号链接：跟随一次，保证 junction / symlink 进来的技能也能统计
      if (entry.isSymbolicLink()) {
        try {
          const info = await stat(full);
          if (info.isDirectory()) {
            await walk(full, depth + 1);
            continue;
          }
        } catch {
          continue;
        }
      }

      fileCount += 1;
      if (SCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        hasScripts = true;
      }
    }
  };

  await walk(root, 0);
  return { fileCount, hasScripts };
}

/** 扫描单个根目录下的技能 */
async function scanRoot(
  root: string,
  origin: SkillOrigin,
): Promise<SkillAsset[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }

  const result: SkillAsset[] = [];

  for (const name of names) {
    if (name.startsWith(".")) continue;

    const dir = join(root, name);
    let info;
    try {
      // stat 而非 lstat：跟随符号链接 / junction
      info = await stat(dir);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;

    const skillFile = join(dir, "SKILL.md");

    // 没有 SKILL.md 的目录不是可加载技能，直接忽略
    if (!existsSync(skillFile)) continue;

    const problems: string[] = [];
    let declaredName = "";
    let description = "";
    let updatedAt = info.mtimeMs;
    let valid = true;

    try {
      const raw = await readFile(skillFile, "utf8");
      const meta = parseFrontmatter(raw);
      declaredName = meta.name;
      description = meta.description;
      updatedAt = (await stat(skillFile)).mtimeMs;

      if (!declaredName) {
        problems.push("frontmatter 缺少 name");
        valid = false;
      } else if (!/^[a-z0-9][a-z0-9-]*$/.test(declaredName)) {
        problems.push("name 只能包含小写字母、数字和连字符，且不能以连字符开头");
        valid = false;
      } else if (declaredName !== name) {
        problems.push(`frontmatter name（${declaredName}）与目录名不一致`);
      }

      if (!description) {
        problems.push("frontmatter 缺少 description，Agent 难以判断何时调用");
      }
    } catch (err) {
      problems.push(
        `SKILL.md 读取失败：${errorMessage(err)}`,
      );
      valid = false;
    }

    const contents = await scanContents(dir);

    result.push({
      id: `${origin}:${name}`,
      slug: name,
      name: declaredName || name,
      description,
      origin,
      path: dir,
      valid,
      problems,
      fileCount: contents.fileCount,
      hasScripts: contents.hasScripts,
      updatedAt,
    });
  }

  return result;
}

/**
 * 资产目录缓存。
 *
 * 技能扫描会逐个目录 stat + 读 SKILL.md；切换资产页 / 员工绑定页 / @ 提及
 * 都会触发 listSkills，短时间内的重复扫描没有意义。TTL 内直接复用结果，
 * 写操作后主动失效。
 */
let skillsCache: { at: number; items: SkillAsset[] } | null = null;
let skillsInFlight: Promise<SkillAsset[]> | null = null;
const SKILLS_CACHE_TTL_MS = 3000;

export function invalidateSkillsCache(): void {
  skillsCache = null;
}

/** 扫描技能目录，按名称排序 */
async function scanSkills(): Promise<SkillAsset[]> {
  const skills = await scanRoot(claudeSkillsDir(), "claude-global");
  return skills.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function listSkills(): Promise<SkillAsset[]> {
  if (skillsCache && Date.now() - skillsCache.at < SKILLS_CACHE_TTL_MS) {
    return Promise.resolve(skillsCache.items);
  }
  if (skillsInFlight) return skillsInFlight;

  const run = scanSkills()
    .then((items) => {
      skillsCache = { at: Date.now(), items };
      return items;
    })
    .finally(() => {
      skillsInFlight = null;
    });
  skillsInFlight = run;
  return run;
}

/** 按 id 取单个资产；供 IPC 层打开目录等操作复用 */
export async function getSkillAsset(id: string): Promise<SkillAsset | null> {
  return (await listSkills()).find((skill) => skill.id === id) ?? null;
}

// ============================================================================
// 导入
// ============================================================================

function toSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "skill";
}

function uniqueSlug(base: string): string {
  let slug = base;
  let index = 2;
  while (existsSync(join(claudeSkillsDir(), slug))) {
    slug = `${base}-${index}`;
    index += 1;
  }
  return slug;
}

/**
 * 查找技能文档。
 *
 * 优先精确的 `SKILL.md`；同时识别 `SKILL.md.txt` 这类带后缀的文件 ——
 * Windows 资源管理器默认隐藏扩展名，用户看到的「SKILL.md」实际可能是
 * `SKILL.md.txt`，导入时一并识别并在复制后统一重命名为 SKILL.md。
 */
async function findSkillDocument(dir: string): Promise<string | null> {
  const exact = join(dir, "SKILL.md");
  if (existsSync(exact)) return exact;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const candidate = names
    .filter((name) => /^skill\.md(\..+)?$/i.test(name))
    .sort((a, b) => a.length - b.length)[0];
  return candidate ? join(dir, candidate) : null;
}

/** 选出要导入的技能目录：选中目录本身，或它下面直接包含 SKILL.md 的子目录 */
async function collectSkillDirs(source: string): Promise<string[]> {
  if (await findSkillDocument(source)) return [source];

  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(source);
  } catch {
    return result;
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const dir = join(source, name);
    try {
      if ((await stat(dir)).isDirectory() && (await findSkillDocument(dir))) {
        result.push(dir);
      }
    } catch {
      // 忽略无权限 / 失效链接
    }
  }
  return result;
}

async function importDirectory(source: string): Promise<string> {
  const skillFile = await findSkillDocument(source);
  if (!skillFile) throw new Error(`没有找到 SKILL.md：${source}`);

  const raw = await readFile(skillFile, "utf8");
  const { name } = parseFrontmatter(raw);
  const slug = uniqueSlug(toSlug(name || basename(source)));
  const target = join(claudeSkillsDir(), slug);

  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, filter: copyFilter });

  // 统一改成 Agent 能识别的文件名（如 SKILL.md.txt → SKILL.md）
  const copiedName = basename(skillFile);
  if (copiedName !== "SKILL.md") {
    await rename(join(target, copiedName), join(target, "SKILL.md"));
  }
  return target;
}

async function importFile(source: string): Promise<string> {
  const raw = await readFile(source, "utf8");
  const { name } = parseFrontmatter(raw);

  const fileBase = basename(source, extname(source));
  const fallback = fileBase.toLowerCase() === "skill" ? basename(dirname(source)) : fileBase;
  const slug = uniqueSlug(toSlug(name || fallback));
  const target = join(claudeSkillsDir(), slug);

  await mkdir(target, { recursive: true });
  await writeFile(join(target, "SKILL.md"), raw, "utf8");
  return target;
}

/**
 * 从指定路径导入技能（选择框由 IPC 层负责）。
 *
 * 目录导入支持两种选择方式：
 * - 直接选中一个技能目录（含 SKILL.md）
 * - 选中一个父目录，批量导入其下所有技能子目录
 */
export async function importSkillsFromPath(
  selected: string,
  kind: SkillImportKind,
): Promise<SkillImportResult> {
  const importedPaths: string[] = [];

  try {
    await mkdir(claudeSkillsDir(), { recursive: true });

    if (kind === "file") {
      if (extname(selected).toLowerCase() !== ".md") {
        return { ok: false, imported: [], error: "请选择 SKILL.md 或 .md 文件" };
      }
      importedPaths.push(await importFile(selected));
    } else {
      const dirs = await collectSkillDirs(selected);
      if (dirs.length === 0) {
        return {
          ok: false,
          imported: [],
          error:
            "没有找到 SKILL.md（也接受 SKILL.md.txt 这类文件名），也没有包含 SKILL.md 的子目录",
        };
      }
      for (const dir of dirs) {
        importedPaths.push(await importDirectory(dir));
      }
    }
  } catch (err) {
    return {
      ok: false,
      imported: [],
      error: errorMessage(err),
    };
  }

  invalidateSkillsCache();
  const wanted = new Set(importedPaths);
  const imported = (await listSkills()).filter((skill) => wanted.has(skill.path));
  return { ok: true, imported };
}

// ============================================================================
// 删除 / 文档读写
// ============================================================================

export async function deleteSkill(id: string): Promise<boolean> {
  const asset = await getSkillAsset(id);
  if (!asset) return false;

  await rm(asset.path, { recursive: true, force: true });
  invalidateSkillsCache();
  return true;
}

/**
 * 列出技能目录下的所有文件与子目录。
 *
 * 返回扁平列表（相对路径统一用 `/`），由渲染层拼成目录树；
 * 跳过 `.git` / `node_modules` 等噪音目录，并设总量上限。
 */
export async function listSkillFiles(id: string): Promise<FileEntry[] | null> {
  const asset = await getSkillAsset(id);
  if (!asset) return null;

  const result: FileEntry[] = [];

  const walk = async (
    dir: string,
    prefix: string,
    depth = 0,
  ): Promise<void> => {
    // 深度上限用于兜住符号链接成环的情况
    if (result.length >= FILE_LIST_LIMIT || depth > 12) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (result.length >= FILE_LIST_LIMIT) return;
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === ".DS_Store"
      ) {
        continue;
      }

      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      let isDirectory = entry.isDirectory();

      // 跟随符号链接 / junction，避免链接进来的目录显示成普通文件
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = (await stat(full)).isDirectory();
        } catch {
          continue;
        }
      }

      result.push({ name: entry.name, relativePath, isDirectory });
      if (isDirectory) await walk(full, relativePath, depth + 1);
    }
  };

  await walk(asset.path, "");
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** 读取技能目录下的单个文件；二进制或文本都返回元信息 */
export async function readSkillFile(
  id: string,
  relativePath: string,
): Promise<SkillFileDocument | null> {
  const asset = await getSkillAsset(id);
  if (!asset) return null;

  const filePath = resolveInside(asset.path, relativePath);
  if (!filePath || !(await isInsideReal(asset.path, filePath))) return null;

  const snapshot = await readTextFileLimited(filePath, DOCUMENT_LIMIT);
  if (!snapshot) return null;

  return {
    relativePath,
    path: filePath,
    content: snapshot.content,
    truncated: snapshot.truncated,
    binary: snapshot.binary,
  };
}

/** 把编辑后的内容写回技能目录下的指定文件 */
export async function writeSkillFile(
  id: string,
  relativePath: string,
  content: string,
): Promise<SkillWriteResult> {
  const asset = await getSkillAsset(id);
  if (!asset) return { ok: false, error: "技能不存在，可能已被删除" };

  const filePath = resolveInside(asset.path, relativePath);
  if (!filePath || !(await isInsideReal(asset.path, filePath))) {
    return { ok: false, error: "文件路径不合法" };
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return { ok: false, error: "文件不存在，可能已被删除" };
  }
  if (!info.isFile()) return { ok: false, error: "目标路径不是文件" };

  const written = await writeTextFileLimited(
    filePath,
    content,
    DOCUMENT_LIMIT,
    "文件超过 1MB，请精简后再保存",
  );
  if (!written.ok) return written;

  invalidateSkillsCache();
  const updated = await getSkillAsset(id);
  return updated
    ? { ok: true, asset: updated }
    : { ok: false, error: "保存后重新读取失败" };
}
