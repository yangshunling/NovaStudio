#!/usr/bin/env node
/**
 * 把本地发布说明写入 GitHub Release 页面。
 *
 * 背景：electron-builder 的 GitHub publisher 在创建 Release 时只提交
 * tag_name / name / draft / prerelease，不带 body，所以自动发布的 Release
 * 说明栏总是空的。本脚本在打包发布之后补一次 PATCH。
 *
 * 用法：
 *   node scripts/publish-release-notes.mjs            # 写入当前版本
 *   node scripts/publish-release-notes.mjs --dry-run  # 只打印将要提交的内容
 *   node scripts/publish-release-notes.mjs --notes release/release-notes-0.3.0.md
 *
 * Token 优先级：GH_TOKEN > GITHUB_TOKEN > git credential fill（host=github.com）
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const notesArgIndex = args.indexOf("--notes");
const notesArg = notesArgIndex >= 0 ? args[notesArgIndex + 1] : null;

function fail(message) {
  console.error(`[release-notes] ${message}`);
  process.exit(1);
}

function resolveNotesFile() {
  if (notesArg) {
    const p = resolve(root, notesArg);
    if (!existsSync(p)) fail(`指定的说明文件不存在：${notesArg}`);
    return p;
  }
  const candidates = [
    `release/release-notes-${version}.md`,
    `release-notes/release-notes-${version}.md`,
    `release-notes-${version}.md`,
  ];
  for (const rel of candidates) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }
  const changelog = join(root, "CHANGELOG.md");
  if (existsSync(changelog)) {
    const section = extractChangelogSection(readFileSync(changelog, "utf8"), version);
    if (section) {
      console.warn(`[release-notes] 未找到 ${tag} 的独立说明文件，使用 CHANGELOG.md 对应章节`);
      return { inline: section };
    }
  }
  fail(
    `找不到 ${tag} 的发布说明，请创建 release/release-notes-${version}.md，或用 --notes 指定文件`,
  );
}

function extractChangelogSection(text, v) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+v?${escapeRegExp(v)}\\b`).test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveToken() {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return { token: fromEnv, source: "环境变量" };
  try {
    const out = execFileSync("git", ["credential", "fill"], {
      cwd: root,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const line = out.split(/\r?\n/).find((l) => l.startsWith("password="));
    const token = line ? line.slice("password=".length) : "";
    if (token) return { token, source: "git credential fill" };
  } catch {
    // 落到下面的报错
  }
  fail("未找到 GitHub token：请设置 GH_TOKEN 环境变量，或先让 git 登录 github.com");
}

function resolveRepo() {
  const publish = Array.isArray(pkg.build?.publish) ? pkg.build.publish : [];
  const github = publish.find((p) => p?.provider === "github");
  if (!github?.owner || !github?.repo) {
    fail("package.json 的 build.publish 中缺少 GitHub owner/repo");
  }
  return { owner: github.owner, repo: github.repo };
}

const notes = resolveNotesFile();
const body = typeof notes === "string" ? readFileSync(notes, "utf8").trim() : notes.inline;
if (!body) fail(`发布说明为空：${typeof notes === "string" ? notes : "CHANGELOG.md"}`);

const name = `${pkg.build?.productName || pkg.name} ${version}`;
const { owner, repo } = resolveRepo();

if (dryRun) {
  console.log(`[release-notes] dry-run：${owner}/${repo} ${tag}`);
  console.log(`[release-notes] 标题：${name}`);
  console.log(`[release-notes] 正文 ${body.length} 字符：`);
  console.log(body.split(/\r?\n/).slice(0, 8).join("\n"));
  process.exit(0);
}

const { token, source } = resolveToken();
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "nova-release-notes",
};
const apiRoot = `https://api.github.com/repos/${owner}/${repo}`;

/**
 * GitHub 没有「按 tag PATCH」的接口：先用 tags/{tag} 取 release id，
 * 再按 id 更新。直接 PATCH tags/{tag} 会一律返回 404。
 */
let found;
try {
  // 刚创建的 Release 偶尔会短暂查不到，重试几次再判定不存在
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    found = await fetch(`${apiRoot}/releases/tags/${encodeURIComponent(tag)}`, { headers });
    if (found.status !== 404) break;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
} catch (error) {
  fail(`请求 GitHub 失败：${error.message}（token 来源：${source}）`);
}

if (found.status === 404) {
  fail(`GitHub 上还没有 ${tag} 的 Release。请先运行 npm run package:win:publish 上传安装包，或手动创建该 Release`);
}
if (!found.ok) {
  const text = await found.text().catch(() => "");
  fail(`读取 Release 失败：HTTP ${found.status} ${text.slice(0, 300)}`);
}
const current = await found.json();

let response;
try {
  response = await fetch(`${apiRoot}/releases/${current.id}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ name, body }),
  });
} catch (error) {
  fail(`请求 GitHub 失败：${error.message}（token 来源：${source}）`);
}

if (!response.ok) {
  const text = await response.text().catch(() => "");
  fail(`更新 Release 说明失败：HTTP ${response.status} ${text.slice(0, 300)}`);
}

const release = await response.json();
console.log(`[release-notes] 已更新 ${tag} 的说明：${release.html_url}`);
