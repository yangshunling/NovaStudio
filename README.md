<p align="center">
<img src="resources/banner.svg" alt="Nova Studio" width="100%">
</p>

<div align="center">

# Nova Studio

**一个窗口，管理你的整个 AI 数字团队**

从多 Agent 对话，到数字员工，再到可调试的工作流 —— 全部在本地完成。

<p>
<img alt="Electron 31" src="https://img.shields.io/badge/Electron-31-00B4D8?style=for-the-badge&logo=electron&logoColor=white">
<img alt="React 18" src="https://img.shields.io/badge/React-18-00D8FF?style=for-the-badge&logo=react&logoColor=black">
<img alt="TypeScript 5.5" src="https://img.shields.io/badge/TypeScript-5.5-2563EB?style=for-the-badge&logo=typescript&logoColor=white">
<img alt="Tailwind CSS 4" src="https://img.shields.io/badge/Tailwind%20CSS-4-38BDF8?style=for-the-badge&logo=tailwindcss&logoColor=white">
<img alt="SQLite" src="https://img.shields.io/badge/SQLite-Local-0EA5E9?style=for-the-badge&logo=sqlite&logoColor=white">
<img alt="License MIT" src="https://img.shields.io/badge/License-MIT-22C55E?style=for-the-badge">
</p>

<p>
<a href="#-核心功能"><kbd>核心功能</kbd></a>
<a href="#-界面预览"><kbd>界面预览</kbd></a>
<a href="#-支持的-agent"><kbd>支持的 Agent</kbd></a>
<a href="#-快速开始"><kbd>快速开始</kbd></a>
<a href="#-五分钟上手"><kbd>五分钟上手</kbd></a>
<a href="#-常用命令"><kbd>常用命令</kbd></a>
<a href="#-数据与安全"><kbd>数据与安全</kbd></a>
<a href="#-许可"><kbd>许可</kbd></a>
</p>

</div>

---

## ✨ 为什么是 Nova Studio

大部分 AI 工具只解决“聊天”这一件事。Nova Studio 想解决的是：

> **当你有多个 Agent、多个项目、多个角色时，如何把它们组织成一条真正能跑起来的生产线。**

- **不用在多个 CLI 之间来回切换** —— 一个窗口接入 Pi、OpenCode、Claude Code、Codex；
- **不用每次重新写提示词** —— 把角色、模型、MCP、技能固化成“数字员工”；
- **不用靠人肉传递上下文** —— 把员工串成工作流，节点产物自动交给下一个节点；
- **不用猜它跑到哪一步** —— 在画布上直接调试，节点状态实时可见；
- **数据完全在本地** —— 对话、员工、工作流、运行产物都由你自己保管。

---

## 🚀 核心功能

### 1. 多 Agent 对话工作台

- 自动扫描本机已安装的 Agent CLI，一个窗口统一使用；
- 流式渲染 **思考过程 / 工具调用 / 正文**，工具调用带分类图标与目标摘要；
- 多轮对话复用 CLI 自带 session，完整继承该 Agent 的工具生态；
- 支持 Markdown、GFM 表格、代码高亮；
- 完整事件流落库，重启后仍可回放含思考与工具调用的历史对话；
- 多会话可同时运行，互不阻塞；
- 输入框支持 `@` 提及项目文件。

### 2. 项目与工作区

- 以“文件夹 + 名称”为项目，所有会话共享同一个工作目录；
- 侧栏以「项目 → 会话」树组织，支持折叠、重命名、删除、清空会话；
- 项目同时作为工作流的工作区：运行目录、产物目录都由它决定；
- 可创建多个工作区；不同工作区的运行产物按工作流 ID 与运行 ID 分目录存放，互不覆盖。

### 3. 数字员工

把一份 Agent 运行配置固化成可复用的“员工”：

- 头像、姓名、职位、简介；
- 绑定 Agent 后端与模型；
- 独立的系统提示词 / 人设；
- 启用或禁用 MCP 服务（命令、参数、环境变量）；
- 启用或禁用技能；
- 一键启用 / 停用员工；
- 工作流节点直接引用员工，无需重复填写角色信息。

常见的员工角色示例：需求产品工程师、业务架构师、程序员、测试工程师、代码评审员。

### 4. 工作流编排与调试

**可视化编排**

- 工作区 → 工作流两级管理；
- 画布支持拖拽节点、缩放、平移、自动布局；
- 节点类型：开始、结束、数字员工节点；
- 从节点右侧端口拖出连线，选中连线后可删除或改连目标；
- 点击左侧数字员工即可快速加入节点；
- 运行记录、重命名、复制、删除都在工作流卡片上完成，工作流列表支持搜索。

**节点配置**

- 绑定数字员工；
- 任务详情（下发给该员工的完整指令）；
- 失败策略：失败停止 / 自动跳过 / 自动重试（可配置重试次数）；
- 审核门禁：自动通过 / 人工审核；
- 人工审核在执行前暂停，通过后才启动 Agent，驳回按失败策略处理。

**画布内调试**

- 点「调试」不跳页，直接在当前工作流里运行；
- 节点实时显示执行中、等待审核、成功、失败、跳过、取消；
- 顶部调试栏展示进度、当前节点、耗时、错误信息；
- 等待审核时可直接通过 / 驳回，并查看任务详情；
- 可随时终止本次调试。

**运行记录与产物**

- 每次执行都有独立记录：状态、开始时间、完成时间、总耗时；
- 点击详情可查看每个节点：
  - 提交给 Agent 的系统提示词与完整输入；
  - Agent 的返回内容；
  - 结构化交接单；
  - 运行参数与隔离环境告警；
  - 产物文件列表，可一键打开目录；
- 每个节点独立会话、独立运行环境；支持 Claude Code 的独立配置目录、MCP 与技能隔离；
- 产物落在工作区 `.novastudio/` 下，按工作流 ID 与运行 ID 分目录，互不覆盖；
- 工作流会话不会出现在普通项目会话列表中，避免干扰日常聊天。

### 5. 任务中心（自动化）

- 用自然语言创建任务，绑定项目与 Agent；
- 后台轮询自动拾取、创建会话并执行；
- 看板式状态：待执行 / 执行中 / 已完成 / 失败；
- 支持并发数、轮询间隔、单次运行超时配置；
- 执行详情直接跳转到对应会话。

### 6. 工作区与开发工具

- 工作区文件树，带 Git 状态标记（新增 / 修改 / 删除等）；
- 文件只读预览：文本、Markdown、图片、PDF、二进制；
- 点击文件在中间区域以标签页打开，可随时回到对话；
- 内置系统终端（node-pty），支持多标签、自定义工作目录；
- `@` 文件提及，快速把项目文件加入上下文。

### 7. 主题与个性化

- 内置 2 套皮肤：经典·昼、经典·夜；
- Shiki 代码高亮主题随皮肤联动；
- 界面字号、聊天字号、预览字号可独立调整；
- 默认 Agent、默认工作目录、自动化并发、超时时间均可配置。

---

## 🖼️ 界面预览

<p align="center"><sub>点击图片查看完整尺寸</sub></p>

<table width="100%" style="width:100%">
<tr>
<td align="center" width="50%">
<a href="resources/preview/经典昼.png"><img src="resources/preview/经典昼.png" alt="经典 · 日间" width="100%"></a>
<br><sub><b>经典 · 日间</b></sub>
</td>
<td align="center" width="50%">
<a href="resources/preview/经典夜.png"><img src="resources/preview/经典夜.png" alt="经典 · 夜间" width="100%"></a>
<br><sub><b>经典 · 夜间</b></sub>
</td>
</tr>
</table>

> [!TIP]
> 皮肤提供日间 / 夜间两种模式，可在主界面左上角一键切换。

---

## 🧩 支持的 Agent

| Agent | 会话恢复 | 说明 |
|---|:---:|---|
| **Claude Code** | ✅ | 完整支持工具调用流式解析、历史回放、工作流独立配置隔离 |
| **Codex** | ✅ | 自动检测与多轮会话 |
| **OpenCode** | ✅ | 自动检测与多轮会话 |
| **Pi** | ✅ | 自动检测与多轮会话 |

> 新增 Agent 只需增加一个适配器目录，对话界面、会话管理、工作流引擎与 IPC 无需改动。

---

## ⚡ 快速开始

> [!IMPORTANT]
> 需要 **Node.js 20+（推荐）**、**npm 9+**，以及至少一个本地 Agent CLI（Claude Code / Codex / OpenCode / Pi 任选其一）。
> 当前主要面向 Windows；其他平台可通过源码运行，但未做完整验证。

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建 + 打包 Windows 安装包（产物在 release/）
npm run package:win
```

首次启动后：

1. Nova 会自动扫描本机已安装的 Agent；
2. 创建一个项目（选择一个工作目录）；
3. 直接对话，或继续创建数字员工与工作流。

---

## 🎯 五分钟上手

### 1. 创建项目

点击左侧「新建项目」，选择一个工作目录。项目既是聊天的工作目录，也是工作流的工作区。

### 2. 创建数字员工

进入「数字员工」，为不同角色配置：

- 绑定 Agent 与模型；
- 写清职责边界与输出要求；
- 按需启用 MCP 与技能。

### 3. 创建工作流

进入「工作流」→ 选择工作区 → 「新建工作流」。以一条常见的研发流水线为例：

```
开始 → 需求产品工程师 → 业务架构师 → 程序员 → 代码评审员 → 测试工程师 → 结束
```

点击左侧节点或数字员工即可加入画布，从节点右侧圆点拖出连线。

### 4. 调试

点击工作流卡片上的「调试」，或进入编辑器后点「调试」：

- 节点会在画布上实时变色；
- 顶部显示当前进度与当前节点；
- 人工审核节点会暂停，等待你通过或驳回；
- 可随时终止。

### 5. 查看运行记录与产物

点击「运行记录」：

- 列表展示每次执行的状态、开始时间、完成时间、总耗时；
- 点击详情查看每个节点的输入、返回、交接单和产物文件；
- 产物目录可直接打开。

---

## 📦 工作流产物

每次运行都会在工作区生成独立目录：

```
<workspace>/.novastudio/
└── workflows/<workflowId>/runs/<runId>/
    ├── run.json
    └── nodes/<nodeId>/attempt-1/
        ├── input.md              # 实际提交给 Agent 的输入
        ├── system-prompt.md      # 员工人设 / 系统提示词
        ├── output.md             # Agent 返回
        ├── handoff.md            # 结构化交接单
        ├── agent-options.json    # 模型 / MCP 等运行参数
        └── warnings.txt          # 隔离环境告警（如有）
```

- 不同工作流、不同运行互不覆盖；
- `.novastudio` 内置 `.gitignore`，不会污染业务仓库；
- 运行失败或被取消也会保留已产生的输入与产物，便于排查。

---

## 🛠️ 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发模式（热重载） |
| `npm run build` | 仅构建 |
| `npm run preview` | 预览构建产物 |
| `npm run package` / `package:win` | 构建 + 打包安装包 |
| `npm run verify:skins` | 校验皮肤 token 完整性 |

---

## 🔒 数据与安全

- **本地优先**：对话、员工、工作流、运行记录全部存储在 `~/.novastudio/`，不依赖外部服务；
- **进程隔离**：渲染进程关闭 `nodeIntegration`，开启 `contextIsolation` 与 `sandbox`，Agent 子进程仅在主进程启动；
- **工作区隔离**：每个工作流运行有独立产物目录；Claude Code 节点使用独立配置目录，MCP 与技能按节点隔离；
- **可审计**：每次运行保留输入、返回、交接单、运行参数与事件日志；
- **不会动你的业务目录**：删除工作区只清理 Nova 生成的内容，工作区文件夹本身不会删除。

> [!CAUTION]
> `~/.novastudio/` 存有全部会话与工作流记录，手动删除该目录会清空这些历史数据，且无法从 CLI 侧恢复。

---

## 🗺️ Roadmap

- [x] 多 Agent 统一对话
- [x] 数字员工（人设 / 模型 / MCP / 技能）
- [x] 工作流可视化编排
- [x] 画布内调试与节点实时状态
- [x] 运行记录、节点输入输出与产物
- [x] 工作区级隔离与级联清理
- [ ] MCP / Skill 资产库与勾选式配置
- [ ] 工作流并行分支
- [ ] 中断恢复与断点续跑
- [ ] 更多 Agent 后端的运行时隔离能力

---

## 🤝 参与贡献

欢迎提交 Issue 与 Pull Request。

- 提交前请确保 `npm run build` 与 `npm run verify:skins` 通过；
- 功能改动请尽量附带使用说明或截图；
- 不要提交 `out/`、`release/`、`node_modules/` 等工作区产物。

---

## 📄 许可

本项目**代码**基于 **MIT License** 开源，可自由使用、修改与分发。

> [!NOTE]
> 第三方资源与开源依赖的许可证声明见 [resources/NOTICE.md](resources/NOTICE.md)。

---

<div align="center">

**Nova Studio** · 让每个 Agent 都有自己的工位

</div>
