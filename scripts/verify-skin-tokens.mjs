/**
 * 皮肤契约校验（构建后运行）
 *
 * 把源码契约（src/renderer/skins/contract.ts）与构建产物比对，守住三件事：
 *   1. 每套皮肤都能解析出全部必填 token
 *   2. base / 族的声明用 :where() 归零特异性 —— 覆盖关系不依赖加载顺序
 *   3. CSS 里出现的每个 --c-* 都已登记进契约，杜绝"没人管的临时变量"
 *
 * 皮肤与皮肤族都从磁盘/CSS 自动发现，新增一套皮肤或一个族后本脚本无需改动。
 *
 * 用法：先构建，再运行 `npm run verify:skins`
 * （开发期还有一层运行时校验：src/renderer/skins/validate.ts）
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ASSETS_DIR = "out/renderer/assets";
const SKINS_DIR = "src/renderer/skins";
const CONTRACT = "src/renderer/skins/contract.ts";

/** 定位构建产物里最新的那份 CSS */
function findCss() {
  const dir = join(process.cwd(), ASSETS_DIR);
  if (!existsSync(dir)) {
    throw new Error(`未找到构建产物目录 ${ASSETS_DIR}，请先执行 npm run build`);
  }
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("index-") && f.endsWith(".css"))
    .sort();
  if (files.length === 0) {
    throw new Error(`未找到构建产物，请先执行 npm run build（查找目录：${ASSETS_DIR}）`);
  }
  return join(dir, files[files.length - 1]);
}

const css = readFileSync(findCss(), "utf8");
const contractSrc = readFileSync(CONTRACT, "utf8");

/** 从契约源码里取出指定数组里的 token 名 */
function listOf(name) {
  const m = contractSrc.match(
    new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`),
  );
  if (!m) throw new Error(`未在 ${CONTRACT} 中找到 ${name}`);
  return [...m[1].matchAll(/"(--c-[a-z0-9-]+)"/g)].map((x) => x[1]);
}

const required = listOf("REQUIRED_TOKENS");
const optional = listOf("OPTIONAL_TOKENS");
const derived = listOf("DERIVED_TOKENS");

const tokensIn = (body) =>
  new Set([...body.matchAll(/(--c-[a-z0-9-]+)\s*:/g)].map((x) => x[1]));

/** 取某个精确选择器块里声明的 token 集合 */
function tokensOf(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`${esc}\\s*\\{([\\s\\S]*?)\\}`));
  return m ? tokensIn(m[1]) : null;
}

/** 从磁盘发现皮肤：skins/<id>/index.ts（与 registry.ts 的自动收集一致） */
function findSkins() {
  const dir = join(process.cwd(), SKINS_DIR);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .filter((id) => existsSync(join(dir, id, "index.ts")))
    .sort();
}

/**
 * 从 CSS 发现皮肤族：选择器形如 :where([data-theme^="maid-"])。
 *
 * 族的 CSS 会按族内成员各内联一份（换取"加皮肤零改动"），因此同一前缀
 * 可能出现多次 —— 按前缀合并去重，同时归并各自声明的 token。
 */
function findFamilies() {
  const byPrefix = new Map();
  const re = /:where\(\[data-theme\^="([a-z0-9-]+)"\]\)\s*\{([\s\S]*?)\}/g;
  for (const m of css.matchAll(re)) {
    const merged = byPrefix.get(m[1]) ?? new Set();
    for (const token of tokensIn(m[2])) merged.add(token);
    byPrefix.set(m[1], merged);
  }
  return [...byPrefix].map(([prefix, tokens]) => ({ prefix, tokens }));
}

let failed = false;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failed = true;
};

const base = tokensOf(":where([data-theme])");
if (!base) {
  console.log("FAIL  未找到 skins/_base.css 的 :where([data-theme]) 块");
  process.exit(1);
}

const skins = findSkins();
const families = findFamilies();

console.log(
  `契约：必填 ${required.length} 项 / 可选 ${optional.length} 项 / 派生 ${derived.length} 项`,
);
console.log(
  `发现皮肤 ${skins.length} 套、皮肤族 ${families.length} 个（${families.map((f) => f.prefix + "*").join(", ") || "无"}）\n`,
);

// 覆盖关系必须由特异性保证，而不是靠加载顺序
if (!/:where\(\[data-theme\]\)/.test(css)) fail("base 未使用 :where() 归零特异性");

for (const id of skins) {
  const skin = tokensOf(`[data-theme="${id}"]`);
  if (!skin) {
    fail(`${id}: 未在构建产物中找到皮肤块`);
    continue;
  }
  // 命中该皮肤所属的族（按前缀匹配）
  const fromFamilies = families.filter((f) => id.startsWith(f.prefix));
  for (const f of fromFamilies) {
    if (!new RegExp(`:where\\(\\[data-theme\\^="${f.prefix}"\\]\\)`).test(css)) {
      fail(`族 ${f.prefix}* 未使用 :where() 归零特异性`);
    }
  }
  const effective = new Set([
    ...base,
    ...fromFamilies.flatMap((f) => [...f.tokens]),
    ...skin,
  ]);
  const missing = required.filter((t) => !effective.has(t));
  if (missing.length) {
    fail(`${id}: 缺少 ${missing.join(", ")}`);
  } else {
    const via = fromFamilies.length ? `（含族 ${fromFamilies.map((f) => f.prefix + "*").join(", ")}）` : "";
    console.log(`OK    ${id}: ${effective.size} 个 token，必填项全部解析${via}`);
  }
}

// 反向守卫：CSS 里出现的每个 token 都要能被契约解释
const declared = new Set([...css.matchAll(/(--c-[a-z0-9-]+)\s*:/g)].map((x) => x[1]));
const known = new Set([...required, ...optional, ...derived]);
const undocumented = [...declared].filter((t) => !known.has(t));
if (undocumented.length) {
  fail(`以下 token 出现在 CSS 里但未登记进 ${CONTRACT}:\n      ${undocumented.join(", ")}`);
}

console.log(failed ? "\n结果：存在差异" : "\n结果：全部一致");
process.exit(failed ? 1 : 0);
