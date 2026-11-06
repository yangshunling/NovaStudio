# 13 Skill 技能管理

## 1. 目的与边界

技能以磁盘目录为唯一事实来源：

```
~/.claude/skills/
└── <skill-name>/
    ├── SKILL.md
    ├── scripts/
    └── ...
```

Nova 不维护自己的技能主库：

- 新增 / 导入直接写入 `~/.claude/skills`；
- 目录下所有技能都可以在 Nova 中编辑 / 删除；
- 保存时直接写回文件；
- 运行时按员工选择复制子集到临时配置目录。

---

## 2. 数据模型

```ts
export type SkillOrigin = "claude-global";

export interface SkillAsset {
  id: string;          // `claude-global:<dir-name>`
  slug: string;        // 目录名
  name: string;        // frontmatter name，缺失回退目录名
  description: string;
  origin: SkillOrigin;
  path: string;        // 技能目录绝对路径
  valid: boolean;
  problems: string[];
  fileCount: number;   // 最多统计 200
  hasScripts: boolean;
  updatedAt: number;   // SKILL.md mtime
}

export interface SkillFileDocument {
  relativePath: string;
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export type SkillImportKind = "directory" | "file";
```

### 2.1 常量

| 常量 | 值 | 用途 |
|---|---|---|
| `DOCUMENT_LIMIT` | 1MB | SKILL.md / 文件读取上限 |
| `FILE_SCAN_LIMIT` | 200 | 统计文件数上限 |
| `FILE_SCAN_DEPTH` | 3 | 统计深度 |
| `FILE_LIST_LIMIT` | 500 | 文件树上限 |
| `SCRIPT_EXTENSIONS` | `.sh .bash .zsh .fish .ps1 .bat .cmd .py .js .mjs .cjs .ts .rb .pl .lua` | 是否含脚本 |

---

## 3. Frontmatter 解析

文件：`src/main/skills/catalog.ts`

### 3.1 目标

只取 `name` / `description`。技能 frontmatter 字段很少，引入完整 YAML 解析器收益不大。

### 3.2 解析规则

```ts
function parseFrontmatter(raw: string): { name: string; description: string } {
  // 1. 去 BOM，CRLF → LF
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  // 2. 允许 frontmatter 前有空白行；`---` 必须在开头
  const start = text.indexOf("---");
  if (start < 0 || text.slice(0, start).trim() !== "") return { name: "", description: "" };

  // 3. 找结束 `\n---`
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { name: "", description: "" };

  // 4. 逐行解析 `key: value`
  for (const line of body.slice(3, end).split("\n")) {
    const match = /^([A-Za-z0-9_-]+)\s*[:：]\s*(.*)$/.exec(line);
    ...
  }
}
```

支持：

- `key: value`
- 引号包裹：`key: "value"` / `key: 'value'`
- 多行块：`key: >`（折叠为空格）/ `key: |`（保留换行）
- 省略指示符的缩进续行
- 中文全角冒号 `：`（输入法误输入）
- 行尾注释 `# ...`
- CRLF 文件（归一化后 `.` 才能匹配）

**为什么不用完整 YAML**：技能 frontmatter 只需要两个字段，完整解析器增加依赖与攻击面。

### 3.3 校验

```ts
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
```

- `name` 与目录名不一致只 warning，不置 `valid=false`；
- 缺 `description` 只 warning；
- 读取失败置 `valid=false`。

---

## 4. 扫描

```ts
async function scanRoot(root, origin): Promise<SkillAsset[]> {
  for (const name of readdir(root)) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    if (!stat(dir).isDirectory()) continue;

    const skillFile = join(dir, "SKILL.md");
    if (!existsSync(skillFile)) continue;  // 没有 SKILL.md 不是可加载技能

    // 解析 frontmatter + 统计文件
    result.push({ id: `${origin}:${name}`, slug: name, ... });
  }
}
```

- 用 `stat` 而非 `lstat`，跟随符号链接 / junction；
- 跳过 `.git` / `node_modules` / `.DS_Store`；
- 文件统计最多 200 个、深度 3；
- `updatedAt` 取 SKILL.md 的 mtime；
- 按 `slug` 排序。

### 4.1 统计脚本

```ts
if (SCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) hasScripts = true;
```

UI 用 `hasScripts` 提醒用户技能包含可执行脚本。

---

## 5. 导入

### 5.1 两种方式

| 方式 | 行为 |
|---|---|
| `directory` | 选中一个技能目录，或一个父目录批量导入其下技能子目录 |
| `file` | 选中一个 `.md` 文件，作为 `SKILL.md` 写入新目录 |

### 5.2 查找技能文档

```ts
async function findSkillDocument(dir): Promise<string | null> {
  const exact = join(dir, "SKILL.md");
  if (existsSync(exact)) return exact;

  // 兼容 SKILL.md.txt：Windows 资源管理器默认隐藏扩展名，
  // 用户看到的“SKILL.md”实际可能是 SKILL.md.txt
  const candidate = readdir(dir)
    .filter(name => /^skill\.md(\..+)?$/i.test(name))
    .sort((a, b) => a.length - b.length)[0];
  return candidate ? join(dir, candidate) : null;
}
```

### 5.3 批量目录导入

```ts
async function collectSkillDirs(source) {
  if (await findSkillDocument(source)) return [source]; // 选中目录本身就是技能
  return 子目录中所有含 SKILL.md 的目录;                  // 父目录批量导入
}
```

### 5.4 slug 生成

```ts
function toSlug(raw) {
  return raw.trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "skill";
}

function uniqueSlug(base) {
  let slug = base, index = 2;
  while (existsSync(join(skillsDir, slug))) slug = `${base}-${index++}`;
  return slug;
}
```

- 优先用 frontmatter `name`；
- 目录导入回退目录名；
- 文件导入回退文件名（`skill.md` 时用父目录名）；
- 重名自动加 `-2`、`-3`。

### 5.5 复制

```ts
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, filter: copyFilter });

// SKILL.md.txt → SKILL.md
if (copiedName !== "SKILL.md") await rename(join(target, copiedName), join(target, "SKILL.md"));
```

`copyFilter` 跳过 `.git` / `.DS_Store`。

### 5.6 文件导入

```ts
const raw = await readFile(source, "utf8");
const { name } = parseFrontmatter(raw);
const slug = uniqueSlug(toSlug(name || fallback));
await mkdir(target, { recursive: true });
await writeFile(join(target, "SKILL.md"), raw, "utf8");
```

---

## 6. 文件树与编辑

### 6.1 文件树

`listSkillFiles(id)`：

- 返回扁平 `FileEntry[]`，`relativePath` 用 `/`；
- 渲染层拼成目录树；
- 跳过 `.git` / `node_modules` / `.DS_Store`；
- 最多 500 项，深度 12（防符号链接成环）；
- 跟随符号链接判断目录。

### 6.2 读取文件

```ts
readSkillFile(id, relativePath) {
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
```

- 词法 + realpath 双重越界校验；
- 行尾统一为 LF；
- 前 8KB 出现 NUL 视为二进制，`content` 为空；
- 超过 1MB 截断，`truncated=true`。

### 6.3 写入文件

```ts
writeSkillFile(id, relativePath, content) {
  // 1. 资产存在
  // 2. resolveInside + isInsideReal
  // 3. 目标必须是已存在的普通文件
  // 4. writeTextFileLimited（1MB 上限，原子写）
  // 5. 重新扫描返回最新资产
}
```

**只允许覆盖已存在文件**，不创建新文件。

### 6.4 截断保护

`truncated=true` 时 UI 禁止保存，避免用截断内容覆写原文。

---

## 7. 删除

```ts
async function deleteSkill(id) {
  const asset = await getSkillAsset(id);
  if (!asset) return false;
  await rm(asset.path, { recursive: true, force: true });
  return true;
}
```

**直接删整个技能目录**。没有“只读 / 内置”概念：所有技能都可编辑、可删除。

> 与旧版不同：当前实现不再区分 Nova 创建 / Claude 创建，所有条目都可写。

---

## 8. 运行时投影

### 8.1 聊天

普通聊天直接使用 `~/.claude/skills` 全部技能，不做投影。

### 8.2 工作流节点

Claude provider 的 `prepareRun`：

1. 创建 `<runtimeDir>/claude-home/skills`；
2. 遍历员工 `skills` 中 `enabled` 的项；
3. 新版 `assetId` → `~/.claude/skills/<key>`；
4. 旧版 `source` → 直接用该路径；
5. 不存在 → warning 并跳过；
6. 复制到 `<runtimeDir>/claude-home/skills/<targetKey>`；
7. `CLAUDE_CONFIG_DIR` 指向 `<runtimeDir>/claude-home`。

**为什么只复制子集**：员工只应看到自己绑定的技能，不能让全局技能泄漏给节点。

### 8.3 去重

```ts
const seenSkills = new Set<string>();
for (const ref of employee.skills.filter(s => s.enabled)) {
  const key = skillKey(ref);
  if (!key || seenSkills.has(key)) continue;
  seenSkills.add(key);
  ...
  const targetKey = ref.assetId ? key : basename(source) || key;
  if (seenSkills.has(`target:${targetKey}`)) continue;
  seenSkills.add(`target:${targetKey}`);
  await cp(source, join(skillsDir, targetKey), { recursive: true });
}
```

- 同时按源 key 与目标 key 去重；
- 旧版路径可能指向同名不同位置，避免覆盖。

### 8.4 注入清单

```ts
return {
  injected: { mcpServers: [...], skills: injectedSkills },
};
```

写入 `execution.md`，运行详情可见“实际加载了哪些技能”。

---

## 9. UI

`components/skills/SkillsView.tsx`：

- 技能卡片：名称、描述、来源、文件数、是否含脚本、校验状态；
- 异常技能标「需处理」并展示 `problems`；
- 详情：
  - 基本信息；
  - 文件树；
  - 文件内容预览 / 编辑 / 保存；
  - 打开目录。
- 导入：选择目录 / 文件；
- 删除：二次确认。

`components/asset/EditorUi.tsx` / `AssetUi.tsx` 提供通用编辑布局。

---

## 10. 关键文件索引

| 功能 | 文件 |
|---|---|
| 资产扫描 / 导入 / 编辑 | `src/main/skills/catalog.ts` |
| 路径安全 | `src/main/utils/paths.ts` |
| 文件读写上限 | `src/main/utils/fs.ts` |
| 运行时复制 | `src/main/agents/claude/prepare.ts` |
| IPC | `src/main/ipc/handlers/skill.ts` |
| UI | `src/renderer/components/skills/SkillsView.tsx` |

---

## 11. 复刻验收清单

- [ ] 技能目录为 `~/.claude/skills`。
- [ ] 只识别含 `SKILL.md` 的目录。
- [ ] 兼容 `SKILL.md.txt` 等隐藏扩展名。
- [ ] frontmatter 支持引号、`>` / `|` 多行、全角冒号、CRLF。
- [ ] `name` 缺失 / 非法置 `valid=false`；与目录名不一致只 warning。
- [ ] `description` 缺失只 warning。
- [ ] 文件统计有上限（200 / 深度 3）。
- [ ] 导入目录支持“技能目录”与“父目录批量”。
- [ ] slug 合法化、重名自动加序号。
- [ ] 文件树扁平返回，渲染层拼树。
- [ ] 读取 / 写入做词法 + realpath 越界校验。
- [ ] 只覆盖已存在文件，不新建。
- [ ] 超过 1MB 截断，截断时禁止保存。
- [ ] 删除整个技能目录。
- [ ] 工作流只复制员工选中的技能，结束即删。
