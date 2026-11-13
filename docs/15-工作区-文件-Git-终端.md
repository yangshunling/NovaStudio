# 15 工作区 — 文件、Git 与终端

## 1. 目的与边界

本层覆盖：

- 工作区（复用项目实体）的登记与删除；
- 工作区文件树与懒加载；
- 只读文件预览（文本 / Markdown / 图片 / PDF / 二进制）；
- Git 工作区状态；
- 基于 node-pty 的系统终端；
- 会话页的右侧文件面板与文件 / 终端标签。

不包含：

- 工作流产物目录（见 10）；
- 知识库 / Skill 文件（见 13 / 14）。

---

## 2. 工作区 = 项目

### 2.1 概念

工作区在 DB 里就是 `projects` 表：

```ts
interface Project {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}
```

- 会话可选绑定工作区；
- 工作流必须归属一个工作区；
- 工作区是文件树、`#` 文件引用、终端、产物目录的根；
- 新增 / 删除统一在「工作区」页面完成，其他页面只读取。

### 2.2 创建

`project:create` handler：

```ts
const trimmed = name.trim();
if (!trimmed) throw new Error("工作区名称不能为空");
if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
  throw new Error("工作区目录不存在或不是文件夹");
}

const normalize = value =>
  value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const duplicate = db.listProjects().find(p => normalize(p.cwd) === normalize(cwd));
if (duplicate) throw new Error(`该目录已是工作区「${duplicate.name}」`);

return db.createProject(trimmed, cwd);
```

- 目录必须存在且是文件夹；
- 路径归一化（分隔符、尾斜杠、Windows 大小写）后去重；
- 渲染层同样做一次 `samePath` 检查，避免用户先看到错误再提示。

### 2.3 删除

`project:delete` handler：

```ts
if (runner.hasActiveRunInWorkspace(id)) {
  throw new Error("该工作区有运行中的工作流，请先终止运行");
}

await deleteWorkspaceData(id, { service, userDataDir });
```

`deleteWorkspaceData`（见 10）：

1. 删除该工作区下所有工作流（运行记录、节点、事件、尝试、会话、产物）；
2. `releaseProject` 中断并清理普通会话；
3. `db.deleteProject`；
4. 删除 `.novastudio/workflows`；
5. **不删除用户目录本身**。

### 2.4 打开目录

`project:reveal` → `shell.openPath(project.cwd)`。

---

## 3. 文件树

### 3.1 懒加载

`project:listFiles(projectId, subPath?)`：

- 只列当前层，不递归；
- 渲染层根目录与每个展开目录分别请求；
- 最多 200 项。

### 3.2 按需监听

工作区文件面板不再递归监听整棵树，而是由渲染层声明「当前需要监听的目录集合」：

- 根目录 + 当前展开的目录，每个目录一个非递归 `fs.watch`；
- 离开文件标签、目录收起或切换工作区时，从集合中移除并释放句柄；
- 目录集合通过 `workspace:watch` 同步给主进程，传空数组等于关闭监听；
- 主进程按项目合并 250ms 内的多次变化，只推送变化的相对目录（`workspace:changed`）；
- 渲染层只重拉脏目录，展开状态与滚动位置不受影响；
- 监听失败（无权限、inotify 上限）静默跳过，由手动刷新兜底，不轮询。

### 3.3 忽略规则

```ts
// src/main/files/ignore.ts
const IGNORED_DIR_NAMES = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".output",
  ".svelte-kit", ".turbo", ".vercel", "coverage", ".cache",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  "target", ".gradle", ".idea", ".vscode",
]);
const IGNORED_FILE_PREFIXES = [".DS_Store"];
```

列目录与监听共用同一份规则：列目录时跳过的目录，监听时也不上报事件，避免安装依赖触发海量刷新。

### 3.4 路径安全

```ts
const cwd = await realpath(project.cwd);
const target = await resolveInsideReal(cwd, subPath ?? "");
if (!target) return [];
```

- `subPath` 由渲染层传入，不可信；
- 词法 + realpath 双重校验；
- 符号链接逃逸被拦截。

### 3.5 排序

- 文件夹在前；
- 同类型按名称 `localeCompare`。

### 3.6 Git 状态覆盖

`WorkspacePanel` 额外处理：

- `statusByPath`：文件 → 状态；
- `directoryStatusByPath`：目录 → 最高优先级状态 + 文件计数；
- 已删除但仍在文件树中的路径，用 `overlayDeletedEntries` 补出来，显示为 `D`。

状态标记：

| 状态 | 标记 | 颜色 |
|---|---|---|
| untracked | U | success |
| added | A | success |
| modified | M | accent |
| deleted | D | error |
| renamed | R | agent-sky |
| copied | C | agent-teal |
| conflicted | ! | error |
| changed | M | text-secondary |

---

## 4. 文件预览

### 4.1 类型

```ts
type FilePreviewKind = "text" | "markdown" | "image" | "pdf" | "binary";
```

### 4.2 大小限制

| 常量 | 值 |
|---|---|
| `MAX_TEXT_BYTES` | 2MB |
| `MAX_EMBED_BYTES` | 25MB |

### 4.3 分支

```ts
if (图片扩展名) {
  if (size > 25MB) return binaryPreview("文件过大，未生成预览");
  return { kind: "image", dataUrl: base64 };
}

if (extension === "pdf") {
  if (size > 25MB) return binaryPreview(...);
  return { kind: "pdf", dataUrl: base64 };
}

const knownText = TEXT_EXTENSIONS.has(extension);
if (!knownText && size > 2MB) return binaryPreview(...);

const buffer = await readPrefix(fullPath, 2MB);
if (!knownText && looksBinary(buffer)) return binaryPreview(...);

return {
  kind: MARKDOWN_EXTENSIONS.has(extension) ? "markdown" : "text",
  content,
  language,
  truncated: size > 2MB,
};
```

### 4.4 文本解码

```ts
function decodeText(buffer) {
  if (UTF-16 LE BOM) return utf16le;
  if (UTF-16 BE BOM) swap + utf16le;
  if (UTF-8 BOM) return utf8;
  return utf8;
}
```

### 4.5 语言映射

`CODE_LANGUAGES` 覆盖 js/ts/tsx/html/css/json/yaml/toml/xml/md/py/rb/php/go/rs/java/kt/c/cpp/cs/swift/dart/lua/sh/ps1/bat/sql/csv 等，供 Shiki 高亮。

### 4.6 二进制探测

前 8KB 出现 NUL → 二进制。

### 4.7 路径安全

```ts
async function resolveInside(root, candidate) {
  if (!isInside(root, candidate)) throw new Error("文件路径超出项目目录");
  const fullPath = await realpath(candidate);
  if (!isInside(root, fullPath)) throw new Error("文件路径超出项目目录");
  return fullPath;
}
```

### 4.8 Markdown 内嵌图片

`file:readEmbeddedImage(projectId, markdownPath, src)`：

- 远程 URL / data URL / `//` / `#` → 不处理；
- 去掉 `?query` / `#hash`，`decodeURIComponent`；
- `/` 开头按项目根解析，否则相对 Markdown 文件目录；
- 再次 `resolveInside`；
- 25MB 上限；
- 返回 data URL。

**为什么主进程读**：渲染进程无法直接访问本地文件（页面基址是 dev server / 应用目录）。

### 4.9 系统程序打开

`file:openExternal` → `shell.openPath`；返回 `{ ok, error? }`。

---

## 5. Git 状态

文件：`src/main/git/status.ts`

### 5.1 命令

```ts
git -C <cwd> rev-parse --show-toplevel
git -C <cwd> status --porcelain=v1 -z --branch --untracked-files=all
```

- `-z`：NUL 分隔，避免空格 / 引号 / 换行破坏解析；
- `--branch`：取分支名；
- `--untracked-files=all`：列出未跟踪文件；
- 5 秒超时，16MB 输出上限；
- 失败返回 `{ available: false, branch: null, files: [] }`。

### 5.2 项目前缀

```ts
const repoRoot = rev-parse --show-toplevel;
const projectPrefix = relative(repoRoot, cwd).replace(/\\/g, "/");
if (projectPrefix === ".." || projectPrefix.startsWith("../")) return EMPTY_STATUS;
```

工作区可以是 Git 仓库的子目录，路径要相对于项目目录返回。

### 5.3 解析

```ts
for (const record of raw.split("\0")) {
  if (record.startsWith("## ")) {
    // 分支名
    branch = header.split("...")[0].replace(/^No commits yet on /, "").trim() || null;
    continue;
  }

  const indexStatus = record[0];
  const worktreeStatus = record[1];
  const repoPath = record.slice(3).replace(/\\/g, "/").replace(/^\.\//, "");

  // 重命名 / 复制记录后面还跟一个原路径，跳过
  if (indexStatus === "R" || indexStatus === "C") i += 1;

  files.push({ relativePath: relativeToProject(repoPath, projectPrefix), status: classifyStatus(...) });
}
```

### 5.4 状态分类

| 条件 | 状态 |
|---|---|
| `??` | untracked |
| `U` / `AA` / `DD` | conflicted |
| 任一 `D` | deleted |
| `R` | renamed |
| `C` | copied |
| `A` | added |
| `M` / `T` | modified |
| 其他 | changed |

---

## 6. 终端

### 6.1 主进程

文件：`src/main/terminal/manager.ts`

```ts
interface ManagedTerminal {
  pty: pty.IPty;
  cwd: string;
  shell: string;
}
const terminals = new Map<string, ManagedTerminal>();
const MAX_TERMINALS = 12;
```

#### 创建

```ts
createTerminal(id, cwd?, cols=80, rows=24) {
  if (terminals.has(id)) return existing;

  if (terminals.size >= 12) throw new Error("同时打开的终端已达上限（12 个）");
  if (!cwd) throw new Error("终端工作目录未指定");
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`终端工作目录不存在：${cwd}`);
  }

  const shell = resolveShell();
  const proc = pty.spawn(shell.file, shell.args, {
    name: "xterm-256color",
    cols: clampDimension(cols, 80),
    rows: clampDimension(rows, 24),
    cwd,
    env: process.env,
  });

  terminals.set(id, { pty: proc, cwd, shell: shell.file });
  proc.onData(data => push("terminal:data", { id, data }));
  proc.onExit(({ exitCode, signal }) => {
    terminals.delete(id);
    push("terminal:exit", { id, exitCode, signal });
  });

  return { id, cwd, shell: shell.file };
}
```

- 不静默回退到 `homedir()`：目录被移动 / 删除时要让用户看到原因；
- 尺寸限制 2–1000。

#### Shell

```ts
if (win32) return { file: "powershell.exe", args: ["-NoLogo"] };
return { file: process.env.SHELL || "/bin/bash", args: [] };
```

#### 写 / 调整 / 关闭

```ts
writeTerminal(id, data) → pty.write(data)
resizeTerminal(id, cols, rows) → pty.resize(clamp(cols), clamp(rows))
killTerminal(id) → delete + pty.kill()
stopTerminals() → 全部 kill
```

#### 生命周期

- 窗口关闭 / 渲染进程崩溃 → `stopTerminals()`（`main/index.ts`）；
- 应用退出 → `stopTerminals()`；
- 默认同一工作区复用一个终端；会话菜单「新建终端」传 `forceNew` 可并排开多个，全局上限 12。

### 6.2 渲染层 store

`stores/terminal.ts`：

```ts
interface TerminalSession {
  id: string;
  workspaceId: string | null;
  cwd: string;
  name: string;
  generation: number;   // 重启计数
}
```

- `open({workspaceId, cwd, name, forceNew?})`：同一工作区已存在且未传 `forceNew` 时返回已有 id；
- `restart(id)`：`generation+1`，`TerminalView` 感知后重开 PTY；
- `closeByWorkspace`：删除工作区时关闭对应终端；
- 终端标签跨页面常驻（会话页常驻挂载，`CenterTabs` 切换只隐藏不卸载）。

### 6.3 `TerminalView`

- `@xterm/xterm` + `FitAddon`；
- `processId = ${tab.id}:${tab.generation}:${newId()}`；
- 订阅 `terminal:data` / `terminal:exit`；
- `term.onData` → `ipc.writeTerminal`；
- `ResizeObserver` + `requestAnimationFrame` 适配尺寸；
- 容器 `display:none` 时跳过 fit（避免按 0 列 resize）；
- PTY 创建完成后再次 fit（第一帧可能早于 PTY）；
- 组件卸载时 `killTerminal`。

#### 字体

```ts
const SYSTEM_MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
```

终端固定使用系统等宽字体，不跟随皮肤的 `--c-font-mono`（避免开发字体导致观感不一致）。

#### 剪贴板

xterm 默认把 `Ctrl+V` 当控制字符 `0x16` 发给 PTY，不会粘贴。这里显式处理：

- `Ctrl/Cmd+V`、`Ctrl+Shift+V`、`Shift+Insert` → 粘贴；
- `Ctrl+Shift+C`、`Ctrl+Insert`、`Cmd+C` → 复制选中内容；
- 剪贴板无文本（例如图片）→ 原样发 `0x16`，保留 Claude Code 的图片粘贴能力。

#### 字号

- 创建时取一次 `terminalFontSize`；
- 后续修改通过 `options` 更新，不重建组件（否则会重启 PTY）；
- 范围 8–40px。

#### 主题

终端固定纯黑，不随皮肤明暗切换；`terminalTheme()` 定义颜色。

### 6.4 终端标签布局

终端没有独立侧栏页面，而是会话页中间区域的标签：

- `CenterTabs` 同时列出「对话」、已打开文件与终端标签；
- `CenterPane` 按标签类型渲染 `TerminalView` / `FilePreview`，所有实例保持挂载，切换不重启 PTY；
- 右侧仍是 `WorkspacePanel`，终端选中时会跟随终端所属工作区；
- 从工作区页「打开终端」会切到会话页并定位到该目录；
- 关闭标签直接销毁对应 PTY；关闭多个终端前二次确认。

---

## 7. 文件标签与预览

### 7.1 store

`stores/fileViewer.ts`：

```ts
interface FileTab {
  kind: "file";
  id: string;            // `${projectId}:${relativePath}`
  projectId: string;
  relativePath: string;
  name: string;
}
```

- `openFile`：已存在则激活，不重复添加；
- `activeTabId=null` 表示显示对话；
- `closeTab`：关闭当前后激活相邻标签。

### 7.2 会话页

`CenterPane`：

- 顶部 `CenterTabs`：对话 + 已打开文件；
- 对话常驻，文件预览以 `hidden` 切换，不卸载；
- 文件标签只在当前聊天视图内保持。

### 7.3 终端标签

终端标签可以内嵌 `FilePreview`，覆盖在终端上方；关闭后回到终端，PTY 仍在后台运行。

### 7.4 `FilePreview`

根据 `kind` 渲染：

- `text`：Shiki 高亮；
- `markdown`：MarkdownRenderer；
- `image` / `pdf`：data URL；
- `binary`：大小与说明；
- 顶部工具条：打开原文件 / 关闭 / 复制路径等。

---

## 8. 工作区文件面板

`WorkspacePanel`：

- 右侧第三栏，默认宽度 320，范围 240–560，宽度存 `localStorage`；
- 根目录与展开目录分别 `project:listFiles`；
- 只监听根目录与当前展开目录，目录收起 / 离开文件标签时释放；
- 收到 `workspace:changed` 后只重拉脏目录；
- Git 状态索引 + 目录汇总；
- 已删除文件覆盖显示；
- 点击文件 → `openFile` 或外部 `onOpenFile`；
- 顶部刷新按钮重新拉 Git 状态与当前目录。

---

## 9. 关键文件索引

| 功能 | 文件 |
|---|---|
| 项目 CRUD / 文件列表 | `src/main/ipc/handlers/project.ts` |
| 目录监听 | `src/main/files/watcher.ts` / `src/renderer/lib/file-watch.ts` |
| 忽略规则 | `src/main/files/ignore.ts` |
| 文件读取 / 预览 | `src/main/files/access.ts` |
| 文件 IPC | `src/main/ipc/handlers/file.ts` |
| Git | `src/main/git/status.ts` |
| 终端管理 | `src/main/terminal/manager.ts` |
| 终端 IPC | `src/main/ipc/handlers/terminal.ts` |
| 工作区页 | `components/workspaces/WorkspacesView.tsx` |
| 文件面板 | `components/workspaces/WorkspacePanel.tsx` |
| 终端组件 | `components/terminal/TerminalView.tsx` |
| 终端标签 | `components/chat/CenterTabs.tsx` / `CenterPane.tsx` |
| 终端 store | `stores/terminal.ts` |
| 文件标签 store | `stores/fileViewer.ts` |
| 文件预览 | `components/files/FilePreview.tsx` |

---

## 10. 复刻验收清单

- [ ] 工作区复用 `projects` 表，新增 / 删除只在工作区页。
- [ ] 创建校验目录存在、是文件夹、路径去重。
- [ ] 删除工作区先检查活跃运行，级联清理 Nova 数据，不删用户目录。
- [ ] 文件树懒加载，忽略构建 / 依赖 / VCS 目录，最多 200 项。
- [ ] 只监听根目录与展开目录，250ms 合并，仅重拉脏目录。
- [ ] 文件路径词法 + realpath 双重校验。
- [ ] 预览支持文本 / Markdown / 图片 / PDF / 二进制。
- [ ] 文本 2MB、内嵌 25MB 上限，二进制探测。
- [ ] 文本解码支持 UTF-8 / UTF-16 BOM。
- [ ] Markdown 内嵌图片按文档目录解析并由主进程内联。
- [ ] Git 使用 porcelain v1 + `-z`，支持仓库子目录。
- [ ] 默认同一工作区复用一个终端，`forceNew` 可多开，总上限 12。
- [ ] 终端目录不存在时明确报错，不静默回退。
- [ ] 终端跨页面常驻，切页不重启 PTY。
- [ ] 终端剪贴板快捷键正确，图片粘贴保留 `0x16`。
- [ ] 终端字体固定系统等宽，字号 8–40。
- [ ] 文件标签去重，关闭当前激活相邻标签。
