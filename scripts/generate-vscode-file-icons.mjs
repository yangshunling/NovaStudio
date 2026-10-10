/**
 * 从 @iconify-json/vscode-icons 提取项目实际使用的图标。
 * 图标 JSON 很大，完整打进渲染包不划算；生成文件只保留白名单。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SOURCE = join(
  ROOT,
  "node_modules",
  "@iconify-json",
  "vscode-icons",
  "icons.json",
);
const TARGET = join(
  ROOT,
  "src",
  "renderer",
  "components",
  "ui",
  "vscodeFileIcons.ts",
);

const NAMES = [
  "default-file",
  "default-folder",
  "default-folder-opened",
  "file-type-text",
  "file-type-pdf",
  "file-type-word",
  "file-type-markdown",
  "file-type-html",
  "file-type-css",
  "file-type-js",
  "file-type-reactjs",
  "file-type-typescript",
  "file-type-reactts",
  "file-type-vue",
  "file-type-svelte",
  "file-type-astro",
  "file-type-python",
  "file-type-ruby",
  "file-type-php",
  "file-type-go",
  "file-type-rust",
  "file-type-java",
  "file-type-kotlin",
  "file-type-c",
  "file-type-cpp",
  "file-type-csharp",
  "file-type-swift",
  "file-type-dartlang",
  "file-type-lua",
  "file-type-shell",
  "file-type-powershell",
  "file-type-json",
  "file-type-yaml",
  "file-type-xml",
  "file-type-csv",
  "file-type-excel",
  "file-type-powerpoint",
  "file-type-sql",
  "file-type-sqlite",
  "file-type-image",
  "file-type-audio",
  "file-type-video",
  "file-type-zip",
  "file-type-config",
  "file-type-binary",
  "file-type-license",
  "file-type-docker",
  "file-type-makefile",
];

const collection = JSON.parse(readFileSync(SOURCE, "utf8"));

function resolveIcon(name, trail = []) {
  const icon = collection.icons[name];
  if (icon) return icon;

  const alias = collection.aliases?.[name];
  if (!alias?.parent || trail.includes(name)) {
    throw new Error(`未找到图标: ${name}`);
  }
  return resolveIcon(alias.parent, [...trail, name]);
}

const extracted = {};
for (const name of NAMES) {
  const icon = resolveIcon(name);
  extracted[name] = {
    body: icon.body,
    width: icon.width ?? collection.width ?? 32,
    height: icon.height ?? collection.height ?? 32,
  };
}

const output = `/**
 * 由 scripts/generate-vscode-file-icons.mjs 生成，请勿手工修改。
 */

export interface VscodeIconData {
  body: string;
  width: number;
  height: number;
}

export const VSCODE_FILE_ICONS = ${JSON.stringify(extracted, null, 2)} as const satisfies Record<string, VscodeIconData>;

export type VscodeFileIconKey = keyof typeof VSCODE_FILE_ICONS;
`;

writeFileSync(TARGET, output, "utf8");
console.log(`generated ${NAMES.length} icons -> ${TARGET}`);
