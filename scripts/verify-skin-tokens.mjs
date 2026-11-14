/**
 * 皮肤契约校验（构建后运行）
 *
 * 把源码契约（src/renderer/skins/contract.ts）与构建产物比对，守住三件事：
 *   1. 每套皮肤都能解析出全部必填 token
 *   2. base 的声明用 :where() 归零特异性 —— 覆盖关系不依赖加载顺序
 *   3. CSS 里出现的每个 --c-* 都已登记进契约，杜绝"没人管的临时变量"
 *
 * 皮肤从磁盘自动发现，新增一套皮肤后本脚本无需改动。
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

/** 取某个精确选择器块里声明的 token 集合（构建压缩会去掉属性选择器的引号，两种写法都认） */
function tokensOf(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const loose = esc.replace(/"([^"]*)"/g, '"?$1"?');
  const m = css.match(new RegExp(`${loose}\\s*\\{([\\s\\S]*?)\\}`));
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

console.log(
  `契约：必填 ${required.length} 项 / 可选 ${optional.length} 项 / 派生 ${derived.length} 项`,
);
console.log(`发现皮肤 ${skins.length} 套\n`);

// 覆盖关系必须由特异性保证，而不是靠加载顺序
if (!/:where\(\[data-theme\]\)/.test(css)) fail("base 未使用 :where() 归零特异性");

for (const id of skins) {
  const skin = tokensOf(`[data-theme="${id}"]`);
  if (!skin) {
    fail(`${id}: 未在构建产物中找到皮肤块`);
    continue;
  }
  const effective = new Set([...base, ...skin]);
  const missing = required.filter((t) => !effective.has(t));
  if (missing.length) {
    fail(`${id}: 缺少 ${missing.join(", ")}`);
  } else {
    console.log(`OK    ${id}: ${effective.size} 个 token，必填项全部解析`);
  }
}

// 反向守卫：CSS 里出现的每个 token 都要能被契约解释
const declared = new Set([...css.matchAll(/(--c-[a-z0-9-]+)\s*:/g)].map((x) => x[1]));
const known = new Set([...required, ...optional, ...derived]);
const undocumented = [...declared].filter((t) => !known.has(t));
if (undocumented.length) {
  fail(`以下 token 出现在 CSS 里但未登记进 ${CONTRACT}:\n      ${undocumented.join(", ")}`);
}

/*
 * 首帧主题守卫：默认皮肤 / 明暗 / 启动脚本必须来自同一份常量。
 * 这三处一旦漂移，用户会看到「首帧白底、随后跳夜间」的闪屏。
 */
const defaultSource = readFileSync(
  join(process.cwd(), "src/shared/skin-default.ts"),
  "utf8",
);
const defaultId = /DEFAULT_SKIN_ID\s*=\s*"([^"]+)"/.exec(defaultSource)?.[1];
const defaultAppearance =
  /DEFAULT_SKIN_APPEARANCE\s*=\s*"([^"]+)"/.exec(defaultSource)?.[1];

if (!defaultId) fail("shared/skin-default.ts 缺少 DEFAULT_SKIN_ID");
if (!defaultAppearance) {
  fail("shared/skin-default.ts 缺少 DEFAULT_SKIN_APPEARANCE");
}

const orderedSkins = findSkins()
  .map((id) => {
    const source = readFileSync(
      join(process.cwd(), SKINS_DIR, id, "index.ts"),
      "utf8",
    );
    const order = Number(/order:\s*(\d+)/.exec(source)?.[1] ?? Number.NaN);
    return { id, order };
  })
  .sort((a, b) => a.order - b.order);

if (orderedSkins[0] && defaultId && orderedSkins[0].id !== defaultId) {
  fail(
    `默认皮肤不一致：order 最小的是 ${orderedSkins[0].id}，` +
      `shared/skin-default 声明的是 ${defaultId}`,
  );
}

const htmlPath = join(process.cwd(), "out/renderer/index.html");
if (existsSync(htmlPath)) {
  const html = readFileSync(htmlPath, "utf8");
  if (html.includes("%NOVA_DEFAULT_SKIN%")) {
    fail("index.html 的默认皮肤占位符未被注入（检查 electron.vite.config 插件）");
  }
  if (defaultId && !html.includes(`"${defaultId}"`)) {
    fail(`index.html 首帧默认主题不是 ${defaultId}`);
  }
  if (defaultAppearance && !html.includes(`"${defaultAppearance}"`)) {
    fail(`index.html 首帧默认明暗不是 ${defaultAppearance}`);
  }
  if (defaultId && defaultAppearance) {
    console.log(`OK    first-frame: ${defaultId} / ${defaultAppearance}`);
  }
} else {
  console.log("SKIP  index.html 首帧检查（尚未构建）");
}

console.log(failed ? "\n结果：存在差异" : "\n结果：全部一致");
process.exit(failed ? 1 : 0);
