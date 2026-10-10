/**
 * VS Code 风格彩色文件图标。
 *
 * 图标数据从 @iconify-json/vscode-icons 按白名单提取到本地，
 * 运行时不需要访问网络，也不会把完整图标库打进渲染包。
 */

import { VscodeIcon } from "./VscodeIcon";
import {
  VSCODE_FILE_ICONS,
  type VscodeFileIconKey,
} from "./vscodeFileIcons";

interface FileTypeMeta {
  icon: VscodeFileIconKey;
}

const DEFAULT_FILE: FileTypeMeta = { icon: "default-file" };

const FILE_TYPES: Record<string, FileTypeMeta> = {
  // 文本与文档
  txt: { icon: "file-type-text" },
  text: { icon: "file-type-text" },
  log: { icon: "file-type-text" },
  rtf: { icon: "file-type-text" },
  pdf: { icon: "file-type-pdf" },
  doc: { icon: "file-type-word" },
  docx: { icon: "file-type-word" },
  odt: { icon: "file-type-word" },

  // Markdown
  md: { icon: "file-type-markdown" },
  markdown: { icon: "file-type-markdown" },
  mdx: { icon: "file-type-markdown" },

  // 前端
  html: { icon: "file-type-html" },
  htm: { icon: "file-type-html" },
  css: { icon: "file-type-css" },
  scss: { icon: "file-type-css" },
  sass: { icon: "file-type-css" },
  less: { icon: "file-type-css" },
  js: { icon: "file-type-js" },
  mjs: { icon: "file-type-js" },
  cjs: { icon: "file-type-js" },
  jsx: { icon: "file-type-reactjs" },
  ts: { icon: "file-type-typescript" },
  mts: { icon: "file-type-typescript" },
  cts: { icon: "file-type-typescript" },
  tsx: { icon: "file-type-reactts" },
  vue: { icon: "file-type-vue" },
  svelte: { icon: "file-type-svelte" },
  astro: { icon: "file-type-astro" },

  // 后端与脚本
  py: { icon: "file-type-python" },
  rb: { icon: "file-type-ruby" },
  php: { icon: "file-type-php" },
  go: { icon: "file-type-go" },
  rs: { icon: "file-type-rust" },
  java: { icon: "file-type-java" },
  kt: { icon: "file-type-kotlin" },
  c: { icon: "file-type-c" },
  cc: { icon: "file-type-cpp" },
  cpp: { icon: "file-type-cpp" },
  h: { icon: "file-type-c" },
  hpp: { icon: "file-type-cpp" },
  cs: { icon: "file-type-csharp" },
  swift: { icon: "file-type-swift" },
  dart: { icon: "file-type-dartlang" },
  lua: { icon: "file-type-lua" },
  sh: { icon: "file-type-shell" },
  bash: { icon: "file-type-shell" },
  zsh: { icon: "file-type-shell" },
  fish: { icon: "file-type-shell" },
  ps1: { icon: "file-type-powershell" },
  bat: { icon: "file-type-shell" },
  cmd: { icon: "file-type-shell" },

  // 数据与配置
  json: { icon: "file-type-json" },
  jsonc: { icon: "file-type-json" },
  yaml: { icon: "file-type-yaml" },
  yml: { icon: "file-type-yaml" },
  toml: { icon: "file-type-config" },
  ini: { icon: "file-type-config" },
  conf: { icon: "file-type-config" },
  config: { icon: "file-type-config" },
  env: { icon: "file-type-config" },
  xml: { icon: "file-type-xml" },
  svg: { icon: "file-type-image" },
  csv: { icon: "file-type-csv" },
  tsv: { icon: "file-type-csv" },
  xls: { icon: "file-type-excel" },
  xlsx: { icon: "file-type-excel" },
  ppt: { icon: "file-type-powerpoint" },
  pptx: { icon: "file-type-powerpoint" },
  sql: { icon: "file-type-sql" },
  db: { icon: "file-type-sqlite" },
  sqlite: { icon: "file-type-sqlite" },
  sqlite3: { icon: "file-type-sqlite" },
  lock: { icon: "file-type-binary" },

  // 媒体与压缩包
  png: { icon: "file-type-image" },
  jpg: { icon: "file-type-image" },
  jpeg: { icon: "file-type-image" },
  gif: { icon: "file-type-image" },
  webp: { icon: "file-type-image" },
  bmp: { icon: "file-type-image" },
  ico: { icon: "file-type-image" },
  avif: { icon: "file-type-image" },
  tiff: { icon: "file-type-image" },
  mp3: { icon: "file-type-audio" },
  wav: { icon: "file-type-audio" },
  flac: { icon: "file-type-audio" },
  ogg: { icon: "file-type-audio" },
  m4a: { icon: "file-type-audio" },
  aac: { icon: "file-type-audio" },
  mp4: { icon: "file-type-video" },
  mov: { icon: "file-type-video" },
  avi: { icon: "file-type-video" },
  mkv: { icon: "file-type-video" },
  webm: { icon: "file-type-video" },
  zip: { icon: "file-type-zip" },
  rar: { icon: "file-type-zip" },
  "7z": { icon: "file-type-zip" },
  tar: { icon: "file-type-zip" },
  gz: { icon: "file-type-zip" },
  bz2: { icon: "file-type-zip" },
  xz: { icon: "file-type-zip" },
};

const SPECIAL_FILES: Record<string, FileTypeMeta> = {
  dockerfile: { icon: "file-type-docker" },
  containerfile: { icon: "file-type-docker" },
  makefile: { icon: "file-type-makefile" },
  license: { icon: "file-type-license" },
  readme: { icon: "file-type-text" },
};

function resolveFileType(name: string): FileTypeMeta {
  const lower = name.toLowerCase();
  const special = SPECIAL_FILES[lower];
  if (special) return special;

  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return DEFAULT_FILE;
  return FILE_TYPES[lower.slice(dot + 1)] ?? DEFAULT_FILE;
}

export function FileTypeIcon({
  name,
  size = 16,
  className = "",
}: {
  name: string;
  size?: number;
  /** 保留给调用方；彩色图标不覆盖自身品牌色 */
  toneClassName?: string;
  className?: string;
}) {
  const meta = resolveFileType(name);
  return (
    <VscodeIcon
      icon={VSCODE_FILE_ICONS[meta.icon]}
      size={size}
      className={className}
    />
  );
}
