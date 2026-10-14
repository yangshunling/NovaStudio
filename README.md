# Nova

**AI 智能体 CLI 的统一桌面客户端 · 一个窗口接入所有 Agent**

![Electron 31](https://img.shields.io/badge/Electron-31-47848F?style=flat-square&logo=electron&logoColor=white)
![React 18](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)
![TypeScript 5.5](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Tailwind CSS 4](https://img.shields.io/badge/Tailwind%20CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-11-003B57?style=flat-square&logo=sqlite&logoColor=white)

面向 **Pi · OpenCode · Claude Code · Codex** 等本地智能体 CLI 的统一桌面客户端：扫描本机已安装的 Agent，spawn CLI 子进程并流式渲染思考 / 工具调用 / 正文分区，多轮对话复用 CLI 自带 session，安装即用。

[为什么选择](#-为什么选择-nova) · [效果预览](#-效果预览) · [支持范围](#-支持范围) · [快速开始](#-快速开始) · [打包与数据](#-打包与数据) · [桌面控制台](#-桌面控制台)

---

## 💡 为什么选择 Nova

> 💡 **本地装了哪个 Agent，Nova 就能调度哪个**
>
> 不重造 Agent Loop，直接 spawn 现成的 CLI，思考 / 工具 / 正文分区流式渲染。

| 能力 | 说明 |
|---|---|
| 🔌 **统一入口，保留原生 Agent** | 不重造 Agent Loop，直接 spawn 本地 CLI，完整继承其工具生态（MCP / Skills / Hooks / 子代理），思考、工具调用与正文按分区流式渲染 |
| 🧩 **适配器架构，即插即用** | 一个 Agent = 一个目录。通用执行引擎只写一次，通过注入不同适配器支持不同工具；新增 Agent 只加文件，引擎、IPC 与前端零改动 |
| ⚡ **零部署本地运行** | 纯 Electron 客户端，一个安装包交付；IPC 替代 WebSocket 更低延迟，SQLite 本地持久化无需数据库服务 |
| 🔄 **多轮会话，职责分离** | 复用 CLI 自带 session 机制（`--resume`），AI 上下文由 CLI 管理（压缩 / 工具状态 / 思考链），UI 展示由 SQLite 管理，删除会话时同步清理 CLI 侧数据 |
| 📊 **全链路可观测** | 思考过程、工具调用、正文分区展示；完整事件流落库，应用重启后可回放完整对话（含思考与工具） |
| 🎨 **多套皮肤一键切换** | 内置 4 套皮肤（经典 / 女仆工坊 × 昼 / 夜）一键切换，Shiki 代码高亮主题随皮肤联动，女仆工坊皮肤带宫殿背景与双侧立绘 |

---

## 🖼️ 效果预览

> 下图为皮肤背景素材，实际界面请启动应用查看。

| 女仆工坊 · 夜 | 女仆工坊 · 昼 |
|---|---|
| ![女仆工坊 · 夜](src/renderer/assets/maid/palace-night.webp) | ![女仆工坊 · 昼](src/renderer/assets/maid/palace-day.webp) |

> 🎨 **皮肤说明**
>
> 「女仆工坊」皮肤会在内容区背后注入宫殿背景与双侧角色立绘，明暗两套各成风格；「经典」皮肤为纯色主题，无装饰舞台。所有皮肤的色卡 token 在设置面板以预览卡片展示，代码高亮主题随皮肤自动切换。

---

## 🧩 支持范围

### 内置 Agent

| Agent | 检测命令 | 多轮恢复 | 会话存储 | 可配项 |
|---|---|---|---|---|
| Pi | `pi --version` | `--session <id>` | `~/.pi/agent/sessions/`（JSONL） | 模型、思考档位 |
| OpenCode | `opencode` | 内置 session | OpenCode 自身数据库 | 模型（provider/model）、思考档位 |
| Claude Code | `claude --version` | `--resume <id>` | `~/.claude/projects/`（JSONL） | 模型、权限模式 |
| Codex | `codex` | `codex exec resume <thread_id>` | `~/.codex/sessions/`（rollout） | 模型、沙箱策略 |

> 💡 **适配器机制**
>
> 每个 Agent 是 `src/main/agents/<id>/` 下的一个包，导出 `provider`（manifest + 命令构造 + 输出解析 + 会话读写）。注册表按目录静态收集，新增 Agent 无需改动任何既有代码。

### 会话策略：CLI session vs SQLite

| 职责 | 归属 | 说明 |
|---|---|---|
| AI 上下文（历史 / 压缩 / 工具状态 / 思考链） | CLI 自带 session | CLI 核心竞争力，重造等于重造 Claude Code |
| UI 展示（会话列表 / 事件渲染 / 搜索） | Nova 的 SQLite | CLI session 文件是给 AI 读的，不是给 UI 用的 |
| session ID 映射 | SQLite 记录引用 | 多轮调用时传给 `--resume` |
| 会话删除 | 联动清理 CLI 侧数据 | 删 Nova 会话时同步删除 CLI 的 session 文件 |

---

## 🚀 快速开始

### 1. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 18+ | 运行与构建必需 |
| npm | 9+ | 随 Node 安装 |
| 本地 Agent CLI | 任选其一 | Pi / OpenCode / Claude Code / Codex |

### 2. 开发模式

```bash
npm install
npm run dev
```

### 3. 打包发布

```bash
# 构建 + 打 Windows 安装包
npm run package:win
```

产物位于 `release/`：

| 产物 | 路径 |
|---|---|
| Windows 安装包 | `release/Nova-Setup-0.1.0-x64.exe` |
| 免安装目录 | `release/win-unpacked/Nova.exe` |

> 💡 **首次使用**
>
> 启动后 Nova 自动扫描本机已安装的 Agent CLI 并显示在侧栏；任选一个 Agent、绑定工作目录即可开始对话，多轮对话自动复用 CLI 的 session。

### 4. 其它命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 仅构建（不打包） |
| `npm run preview` | 预览构建产物 |
| `npm run verify:skins` | 校验皮肤 token 完整性 |

---

## 📦 打包与数据

Electron 应用 + better-sqlite3 本地数据库，无外部服务依赖。数据目录与安装目录物理隔离，卸载应用不影响数据。

> ⚠️ **安全实践**
>
> 渲染进程关闭 `nodeIntegration`、开启 `contextIsolation` 与 `sandbox`；`child_process.spawn` 仅在主进程执行，通过 preload 的 `contextBridge` 暴露受限 IPC。

### 核心配置项

| 配置项 | 默认值 | 说明 |
|---|---|---|
| 数据根目录 | `~/.novastudio/` | 与安装目录隔离，卸载不丢数据 |
| SQLite 路径 | `~/.novastudio/data.db` | 单文件数据库，WAL 模式 |
| 轮询周期 | `30000` ms | 自动化任务拾取间隔，下限 5000 ms |
| 并发上限 | `3` | 自动化任务并行数，硬上限 10 |

### 数据表

| 表 | 说明 |
|---|---|
| `projects` | 项目（工作文件夹 + 名称） |
| `sessions` | 会话索引（Agent、CLI 会话引用、标题、消息计数） |
| `messages` | 完整事件流（AgentEvent[] 的 JSON 序列化，供重启后回放） |
| `settings` | 键值对（皮肤、超时、并发等） |
| `automation_tasks` | 自动化看板任务 |

---

## 🖥️ 桌面控制台

| 功能 | 说明 |
|---|---|
| 💬 **对话引擎** | 流式渲染思考块 / 工具调用块 / 正文块，均可折叠；Markdown + Shiki 代码高亮；支持中断运行 |
| 📋 **自动化看板** | 三列看板（待执行 / 执行中 / 已完成），录入自然语言任务绑定项目与 Agent，轮询器按并发上限自动拾取执行，失败可手动重试 |
| 🗂️ **会话管理** | 项目 → 会话树形结构；会话列表与历史搜索；多轮对话复用 CLI session；删除联动清理 CLI 侧数据 |
| 🧭 **工具检测** | 启动即扫描本机已安装的 Agent CLI，按 manifest 顺序展示安装状态与版本 |
| ⚙️ **设置中心** | 皮肤切换（色卡预览）、代码高亮主题、默认 Agent、默认工作目录、运行超时、自动化并发上限 |

---

## 📄 许可

本项目代码暂未声明开源协议。美术资源（女仆工坊皮肤素材）遵循 **CC BY-NC-SA 4.0**（署名 - 非商业性使用 - 相同方式共享），署名与修改情况见 [resources/NOTICE.md](resources/NOTICE.md)；第三方依赖许可证清单亦见该文件。
