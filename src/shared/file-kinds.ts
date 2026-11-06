/**
 * 文件类型判定（主进程与渲染进程共用）
 *
 * 知识库接受任意格式的文件：二进制文件（PDF / Office / 图片 / 压缩包等）
 * 只做存储、列表展示与「用系统程序打开」；文本类文件才会进入全文索引，
 * 并允许在 Nova 内预览与编辑。
 *
 * 判定只依赖扩展名，规则简单可预期：主进程扫描出的 indexed 标记与
 * 渲染层显示的「未索引」提示必须来自同一份名单，避免两边说法不一致。
 */

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx", "mdown"]);

/** 可以按 UTF-8 文本读取、预览与保存的扩展名 */
const TEXT_EXTENSIONS = new Set([
  // 文档
  "txt",
  "text",
  "log",
  "rst",
  "adoc",
  "org",
  "tex",
  "bib",
  ...MARKDOWN_EXTENSIONS,
  // 配置 / 数据
  "json",
  "jsonl",
  "ndjson",
  "jsonc",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "config",
  "properties",
  "env",
  "lock",
  "license",
  // 标记 / 样式
  "xml",
  "html",
  "htm",
  "xhtml",
  "svg",
  "css",
  "scss",
  "sass",
  "less",
  // 代码
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "vue",
  "svelte",
  "py",
  "rb",
  "php",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "groovy",
  "gradle",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "cs",
  "swift",
  "dart",
  "lua",
  "pl",
  "r",
  "jl",
  "m",
  "mm",
  // 脚本 / 查询
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "graphql",
  "gql",
  "proto",
  "diff",
  "patch",
]);

/** 取小写扩展名；没有扩展名或只有前导点时返回空串 */
export function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  if (index <= 0 || index === fileName.length - 1) return "";
  return fileName.slice(index + 1).toLowerCase();
}

/** 是否为 Markdown 文档 */
export function isMarkdownFile(fileName: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(fileName));
}

/** 是否可以按文本处理（预览 / 编辑 / 全文索引） */
export function isTextFile(fileName: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(fileName));
}
