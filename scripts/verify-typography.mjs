/**
 * 排版守卫 —— 守住「一个基准字号 + 一套排版角色」的约定
 *
 * 检查项：
 *   1. 禁止 Tailwind 默认字号（text-xs / text-sm / text-lg …）
 *   2. 禁止任意字号（text-[13px] / text-[0.9rem]）
 *   3. 字号只能来自派生量表（micro / caption / meta / body / body-lg / title / heading / display / hero）
 *   4. hero / display / micro 只允许在白名单文件出现
 *   5. 废弃类（ui-serif）与已删除 token（--c-font-serif / --c-serif-tracking）不得出现；
 *      展示衬线只允许 .ui-type-brand，禁止 font-display 工具类
 *   6. 单个组件文件的字号档位 > 4 时告警（提示收敛成排版角色）
 *
 * 默认 warn 模式：只打印，不阻断。加 --strict 后违规退出码为 1，用于构建 / CI。
 *
 * 用法：npm run verify:type / npm run verify:type:strict
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const RENDERER = join(process.cwd(), "src/renderer");
const STRICT = process.argv.includes("--strict");

/** 派生量表里的全部字号档位（顺序：长的在前，避免 text-body 抢先匹配 text-body-lg） */
const SIZE_NAMES = [
  "body-lg",
  "micro",
  "caption",
  "meta",
  "body",
  "title",
  "heading",
  "display",
  "hero",
];

const SIZE_RE = new RegExp(`\\btext-(${SIZE_NAMES.join("|")})(?![-\\w])`, "g");
const DEFAULT_SIZE_RE =
  /\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)(?![-\w])/g;
const ARBITRARY_SIZE_RE = /\btext-\[[^\]]*(?:px|rem|em)[^\]]*\]/g;
const DEPRECATED_CLASS_RE = /\bui-serif\b/g;
// 只匹配工具类用法；排除 --c-font-display 这类 token 名
const DISPLAY_UTILITY_RE = /(?<![\w-])font-display\b/g;
const REMOVED_TOKEN_RE = /--c-font-serif\b|--c-serif-tracking\b/g;

/** 高影响档位只允许出现在这些文件（相对 src/renderer，统一用 / 分隔） */
const HERO_ALLOWED = new Set([
  "components/app/Sidebar.tsx",
  "components/todos/TodosView.tsx",
]);
const HERO_ROLE_ALLOWED = new Set(["components/todos/TodosView.tsx"]);
const DISPLAY_ALLOWED = new Set(["components/ui/MarkdownRenderer.tsx"]);
const MICRO_ALLOWED = new Set([
  "components/chat/ToolCallCard.tsx",
  "components/chat/ToolDiffView.tsx",
  "components/knowledge/KnowledgeView.tsx",
]);

/** 排版角色：组件应优先使用它们，而不是手拼字号 + 字族 */
const ALLOWED_ROLES = new Set([
  "prose",
  "body",
  "item",
  "note",
  "label",
  "sub",
  "micro",
  "code",
  "code-sm",
  "title",
  "heading",
  "display",
  "hero",
  "brand",
  "entrance",
]);
const ROLE_RE = /\bui-type-([a-z-]+)\b/g;
const BRAND_ALLOWED = new Set(["components/app/Sidebar.tsx"]);
/** 入口主标题：全站唯一的大号展示衬线，只允许空会话入口使用 */
const ENTRANCE_ALLOWED = new Set(["components/chat/AssistantMessageList.tsx"]);
const DISPLAY_ROLE_ALLOWED = new Set(["components/ui/MarkdownRenderer.tsx"]);

/** 单文件允许的字号档位上限：正文 / 标签 / 辅助 / 标题 */
const MAX_STEPS_PER_FILE = 4;
/**
 * 只统计「正文档位」角色：标题类（title / heading / display / brand）是页面骨架，
 * 每个页面都可以有，不参与密度上限。
 */
const DENSITY_ROLES = new Set([
  "prose",
  "body",
  "item",
  "note",
  "label",
  "sub",
  "micro",
  "code",
  "code-sm",
]);
/**
 * 单文件允许的正文档位上限。复杂页面（卡片 + 空态 + 抽屉）会同时用到
 * body/item/note/label/sub/code/code-sm；超过 7 个通常是新档位失控的信号。
 */
const MAX_ROLES_PER_FILE = 7;

/** 递归收集渲染层源码与样式文件 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...walk(full));
    } else if (/\.(tsx?|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
const warnings = [];

function report(list, rel, line, message) {
  list.push({ rel, line, message });
}

const sizeCounts = new Map(SIZE_NAMES.map((name) => [name, 0]));
const roleCounts = new Map([...ALLOWED_ROLES].map((name) => [name, 0]));
const familyCounts = { mono: 0, sans: 0, display: 0 };
let scanned = 0;

for (const file of walk(RENDERER)) {
  const rel = relative(RENDERER, file).replaceAll("\\", "/");
  const content = readFileSync(file, "utf8");
  const isComponent = /\.(tsx|ts)$/.test(file);
  scanned += 1;

  // 已删除 token：任何文件都不允许再出现
  for (const match of content.matchAll(REMOVED_TOKEN_RE)) {
    const line = content.slice(0, match.index).split("\n").length;
    report(
      violations,
      rel,
      line,
      `使用了已删除的 token ${match[0]}（展示衬线只允许 .ui-type-brand）`,
    );
  }

  if (!isComponent) continue;

  const lines = content.split("\n");
  const steps = new Set();
  const roles = new Set();

  lines.forEach((text, index) => {
    const line = index + 1;

    for (const match of text.matchAll(DEFAULT_SIZE_RE)) {
      report(
        violations,
        rel,
        line,
        `禁止 Tailwind 默认字号 ${match[0]}，请改用派生量表档位`,
      );
    }

    for (const match of text.matchAll(ARBITRARY_SIZE_RE)) {
      report(
        violations,
        rel,
        line,
        `禁止任意字号 ${match[0]}，请改用派生量表档位`,
      );
    }

    for (const match of text.matchAll(DEPRECATED_CLASS_RE)) {
      report(
        violations,
        rel,
        line,
        `已废弃的 ${match[0]}，标题请改用 ui-type-title / ui-type-heading`,
      );
    }

    for (const match of text.matchAll(DISPLAY_UTILITY_RE)) {
      report(
        violations,
        rel,
        line,
        "font-display 已移除：展示衬线只允许侧栏品牌角色 ui-type-brand",
      );
    }

    for (const match of text.matchAll(SIZE_RE)) {
      const name = match[1];
      steps.add(name);
      sizeCounts.set(name, (sizeCounts.get(name) ?? 0) + 1);

      if (name === "hero" && !HERO_ALLOWED.has(rel)) {
        report(
          violations,
          rel,
          line,
          "text-hero 只允许品牌区（Sidebar / TodosView 大字）",
        );
      }
      if (name === "display" && !DISPLAY_ALLOWED.has(rel)) {
        report(
          violations,
          rel,
          line,
          "text-display 只允许 Markdown h1",
        );
      }
      if (name === "micro" && !MICRO_ALLOWED.has(rel)) {
        report(
          violations,
          rel,
          line,
          "text-micro 只允许工具参数 / 极密信息白名单文件",
        );
      }
    }

    for (const match of text.matchAll(/\bfont-(mono|sans|display)\b/g)) {
      familyCounts[match[1]] += 1;
    }

    for (const match of text.matchAll(ROLE_RE)) {
      const name = match[1];
      roles.add(name);
      if (!ALLOWED_ROLES.has(name)) {
        report(violations, rel, line, `未知排版角色 ui-type-${name}`);
        continue;
      }
      roleCounts.set(name, (roleCounts.get(name) ?? 0) + 1);

      if (name === "brand" && !BRAND_ALLOWED.has(rel)) {
        report(violations, rel, line, "ui-type-brand 只允许侧栏品牌");
      }
      if (name === "entrance" && !ENTRANCE_ALLOWED.has(rel)) {
        report(violations, rel, line, "ui-type-entrance 只允许空会话入口");
      }
      if (name === "hero" && !HERO_ROLE_ALLOWED.has(rel)) {
        report(violations, rel, line, "ui-type-hero 只允许待办页日期大字");
      }
      if (name === "display" && !DISPLAY_ROLE_ALLOWED.has(rel)) {
        report(violations, rel, line, "ui-type-display 只允许 Markdown h1");
      }
      if (name === "micro" && !MICRO_ALLOWED.has(rel)) {
        report(violations, rel, line, "ui-type-micro 只允许白名单文件");
      }
    }
  });

  if (steps.size > MAX_STEPS_PER_FILE) {
    warnings.push({
      rel,
      line: 1,
      message: `使用了 ${steps.size} 个字号档位（${[...steps].join(" / ")}），建议收敛到 4 个角色`,
    });
  }
  const densityRoles = [...roles].filter((name) => DENSITY_ROLES.has(name));
  if (densityRoles.length > MAX_ROLES_PER_FILE) {
    warnings.push({
      rel,
      line: 1,
      message: `使用了 ${densityRoles.length} 个正文档位（${densityRoles.join(" / ")}），建议收敛`,
    });
  }
}

function printList(title, list) {
  if (list.length === 0) return;
  console.log(`\n${title}（${list.length}）`);
  for (const item of list) {
    console.log(`  ${item.rel}:${item.line}  ${item.message}`);
  }
}

console.log(`[typography] 扫描 ${scanned} 个文件`);
printList("违规", violations);
printList("告警", warnings);

const sizeReport = [...sizeCounts.entries()]
  .filter(([, count]) => count > 0)
  .map(([name, count]) => `${name} ${count}`)
  .join(" | ");
const roleReport = [...roleCounts.entries()]
  .filter(([, count]) => count > 0)
  .map(([name, count]) => `${name} ${count}`)
  .join(" | ");
console.log(`\n字号使用：${sizeReport || "无"}`);
console.log(`排版角色：${roleReport || "无"}`);
console.log(
  `字体族使用：mono ${familyCounts.mono} | display ${familyCounts.display} | sans ${familyCounts.sans}`,
);

if (violations.length === 0 && warnings.length === 0) {
  console.log("\n✓ 排版约定检查通过");
}

if (STRICT && violations.length > 0) {
  console.log(`\n✗ ${violations.length} 项违规（--strict）`);
  process.exit(1);
}

if (!STRICT && violations.length > 0) {
  console.log("\n提示：当前为 warn 模式；加 --strict 可作为构建门禁");
}
