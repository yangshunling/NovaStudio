<p align="center">
<img src="resources/banner.svg" alt="Nova Studio" width="100%">
</p>

<div align="center">

**一个窗口，管理你的整个 AI 数字团队**

从 Claude Code 对话、数字员工，到可调试的工作流与本地知识库 —— 全部在本地完成。

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

> **当你有多个项目、多个角色时，如何把它们组织成一条真正能跑起来的生产线。**

- **不用在终端和文件之间来回切换** —— 一个窗口接入 Claude Code；
- **不用每次重新写提示词** —— 把角色、MCP、技能、知识库固化成“数字员工”；
- **不用靠人肉传递上下文** —— 把员工串成工作流，节点产物自动交给下一个节点；
- **不用把资料散落在各处** —— 把 Markdown 文档收进知识库，员工按需读取并引用；
- **不用猜它跑到哪一步** —— 在画布上直接调试，节点状态实时可见；
- **数据完全在本地** —— 对话、员工、工作流、知识库与运行产物都由你自己保管。

---

## 🚀 核心功能

### 1. Claude Code 对话工作台

- 自动检测本机 Claude Code CLI，一个窗口统一使用；
- 流式渲染 **思考过程 / 工具调用 / 正文**，工具调用带分类图标与目标摘要；
- 多轮对话复用 CLI 自带 session，完整继承 Claude Code 的工具生态；
- 支持 Markdown、GFM 表格、代码高亮；
- 完整事件流落库，重启后仍可回放含思考与工具调用的历史对话；
- 多会话可同时运行，互不阻塞；
- 输入框支持 `@` 提及项目文件。

### 2. 项目与工作区

- 以“文件夹 + 名称”为项目；项目是会话的**可选工作目录**，不是会话的前置层级；
- 「新建会话」页左侧是扁平的会话列表，可直接开聊；需要读写本地文件时，在输入框旁「绑定项目」选择工作目录；
- 每个会话可以独立绑定 / 切换 / 解绑项目；切换目录会开启新的 Agent 上下文，本地历史消息仍保留；
- 项目同时作为工作流的工作区：运行目录、产物目录都由它决定；
- 可创建多个工作区；不同工作区的运行产物按工作流 ID 与运行 ID 分目录存放，互不覆盖。

### 3. 数字员工

把一份可复用的人设与能力固化成“员工”：

- 头像、姓名、职位、简介；
- 加入工作流节点时由 Claude Code 执行，同一员工可在多个节点复用；
- 独立的系统提示词 / 人设；
- 从 Claude MCP 配置勾选服务（服务定义统一在「MCP」页管理，员工只保存引用）；
- 从 Claude 全局技能勾选技能（技能内容统一在「Skill」页管理，员工只保存引用）；
- 从知识库勾选 Markdown 资料（内容统一在「知识库」页管理，运行时作为员工能力的一部分注入）；
- 员工卡片直接展示已启用的 MCP、技能与知识库数量；
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
  - 结果优先展示（Markdown 渲染）；
  - 输入与上下文、告警与记录文件收在折叠区，默认不打扰；
  - 记录文件可点击直接打开；
- 每个节点独立会话；Claude 节点按员工勾选的 MCP / Skill 生成**临时运行投影**（复制本机 `settings.json` + 选中技能，MCP 通过 `--mcp-config` 精确指定），节点结束即删除；连接、登录和默认模型直接复用本机 Claude 配置；
- 产物落在工作区 `.novastudio/` 下，按工作流 ID 与运行 ID 分目录，互不覆盖；
- 工作流会话不会出现在普通会话列表中，避免干扰日常聊天。

### 5. 技能资产

- **Claude 全局技能目录**：`~/.claude/skills/`，Claude 与 Nova 共用；Nova 新增 / 导入直接写入这里；
- **共享技能库**：`~/.agents/skills/`，自动扫描，只读引用；
- Nova 创建的技能可编辑 / 删除；Claude 或其它工具创建的技能只读；
- 支持导入技能目录（可批量导入子目录，兼容 `SKILL.md.txt` 这类隐藏扩展名文件）；
- 自动校验 frontmatter（`name` / `description`）、统计文件数与脚本，异常技能会标记「需处理」；
- 技能卡片与详情明确标注来源、只读原因、使用人数；
- 员工绑定只保存技能引用；运行时按员工选择复制到临时配置目录，实际加载结果写入运行产物；
- 旧版 Nova 技能主库会一次性迁移到 `~/.claude/skills`，原目录归档到 `~/.novastudio/legacy-assets/`。

### 6. MCP 服务管理

- **统一存放**：所有 MCP 定义在 Claude 用户配置 `~/.claude.json` 顶层的 `mcpServers` 中，Claude 终端与 Nova 共用同一套；
- Nova 新增 / 修改 / 删除直接写这份配置；Nova 创建的条目标记为可编辑，Claude 原有条目只读；
- 自动发现项目级 `<项目>/.mcp.json` 与 `~/.claude.json` 的 local scope，只读展示；
- 支持 stdio / HTTP / SSE：stdio 填命令、参数、环境变量，远程填 URL 与请求头；
- 环境变量与请求头支持 `${VAR}` 占位符，运行时从环境解析；字面量密钥会在列表标记「含密钥」；
- 服务卡片带来源、传输方式、只读、含密钥、使用人数等标签；
- 数字员工按引用绑定；运行时只把该员工选中的 MCP 渲染成临时 `mcp.json`，通过 `--mcp-config --strict-mcp-config` 加载；
- 旧版 Nova MCP 主库会一次性迁移到 `~/.claude.json`。

### 7. 知识库

把团队资料整理成 Agent 可复用的本地 Wiki：

- **文件库**：`~/.novastudio/knowledge/<知识库>/`，一个知识库一个目录，可直接用资源管理器管理；
- 左侧知识库列表 + 右侧文档两栏：支持新建、重命名、删除知识库，右键即可打开目录或管理；
- 知识库内支持子文件夹、多选上传与批量删除；
- 只接受 Markdown（`.md` / `.markdown`），单文件上限 100MB；同名文件自动加序号，不覆盖已有资料；
- Markdown 预览支持 GFM 表格与代码高亮，也可用系统程序打开原文件；
- 基于 SQLite FTS5（trigram）的全文检索，支持中文与英文子串匹配；
  - 检索词过短（少于 3 个字符）时自动降级为逐字匹配；
  - 可切换「当前知识库 / 全部知识库」，结果带高亮片段；
  - 超过 8MB 的文档不建全文索引，但仍在列表中可见、可注入；
- 数字员工按引用绑定，工作流节点执行前把知识库目录与文件清单写入系统提示词，Agent 按需读取；
- 已删除 / 空知识库会在运行告警中明确说明，不会阻断工作流。

### 8. 任务中心（自动化）

- 用自然语言创建任务，绑定项目与 Agent；
- 后台轮询自动拾取、创建会话并执行；
- 看板式状态：待执行 / 执行中 / 已完成 / 失败；
- 支持并发数、轮询间隔、单次运行超时配置；
- 执行详情直接跳转到对应会话。

### 9. 工作区与开发工具

- 工作区文件树，带 Git 状态标记（新增 / 修改 / 删除等）；
- 文件只读预览：文本、Markdown、图片、PDF、二进制；
- 点击文件在中间区域以标签页打开，可随时回到对话；
- 内置系统终端（node-pty），支持多标签、自定义工作目录；
- `@` 文件提及，快速把项目文件加入上下文。

### 10. 主题与个性化

- 内置 2 套皮肤：经典·昼、经典·夜；
- Shiki 代码高亮主题随皮肤联动；
- 界面字号、聊天字号可独立调整，文件预览与工作区文件跟随全局字号；
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
| **Claude Code** | ✅ | 完整支持工具调用流式解析、历史回放；直接复用本机配置，按员工投影 MCP / Skill |

> 当前只支持 Claude Code。架构上仍保留 provider 适配层，未来新增 Agent 只需增加一个适配器目录。
>
> 知识库通过系统提示词注入，对 Claude Code 生效。

### Agent 平台（运行环境）

- 侧栏「运行环境 → Agent 平台」是 Claude Code 本机配置的统一入口；
- 显示已安装状态、版本、本机配置路径；未安装时给出安装命令，支持一键复制与重新检测；
- **Claude Code 支持完整编辑**：
  - Base URL、API Key；
  - 默认模型 + Fable / Opus / Sonnet / Haiku 四个别名槽位，并显示已配置模型数量；
  - 默认权限（`permissions.defaultMode`）；终端 CLI、Nova 会话与工作流节点统一按它运行；
- 所有修改**直接写回 `~/.claude/settings.json`**，Claude CLI 与 Nova 共用同一份配置，不维护第二份副本；
- 工作流节点由 Claude Code 执行，连接、默认模型与权限全部来自本机 CLI 配置；员工只选择 MCP / Skill 子集，不再提供节点级运行参数；
- MCP 的新增 / 修改统一写入 `~/.claude.json`，Skill 的新增 / 修改统一写入 `~/.claude/skills`；
- 每个员工的 MCP / Skill 子集在运行时投影为临时配置，节点结束即删除；
- 旧版 Nova 的 MCP / Skill 主库与 `agent-connections` 会在启动时迁移并归档到 `~/.novastudio/legacy-assets/`。

> [!NOTE]
> 首次升级会写入 `~/.claude.json` 和 `~/.claude/skills`。建议先退出正在运行的 Claude Code，避免两边同时写同一份配置。

---

## ⚡ 快速开始

> [!IMPORTANT]
> 需要 **Node.js 20+（推荐）**、**npm 9+**，以及本机安装的 **Claude Code CLI**。
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

1. Nova 会自动检测本机 Claude Code 是否已安装；
2. 点击「新建会话」直接开始对话；
3. 需要读写本地文件时，在输入框旁「绑定项目」选择一个工作目录（没有项目则使用默认目录）。

---

## 🎯 五分钟上手

### 1. 开始对话

点击左侧「新建会话」即可直接提问。需要让 Agent 在某个代码目录里工作时，点击输入框旁的「绑定项目」选择一个本地文件夹；该文件夹会被登记为项目，同时也是工作流的工作区。

### 2. 创建数字员工

进入「数字员工」，为不同角色配置：

- 写清职责边界与输出要求（加入工作流节点后由 Claude Code 执行）；
- 按需启用 MCP、技能与知识库。

### 3. 创建知识库

进入「知识库」→「新建知识库」，然后在右侧上传 Markdown 文档；也可以新建子文件夹分类存放。

创建后回到「数字员工」→「知识库」标签页勾选引用。工作流执行到该员工时，Nova 会把知识库目录与文件清单写入系统提示词，Agent 会按需读取并引用。

### 4. 创建工作流

进入「工作流」→ 选择工作区 → 「新建工作流」。以一条常见的研发流水线为例：

```
开始 → 需求产品工程师 → 业务架构师 → 程序员 → 代码评审员 → 测试工程师 → 结束
```

点击左侧节点或数字员工即可加入画布，从节点右侧圆点拖出连线。

### 5. 调试

点击工作流卡片上的「调试」，或进入编辑器后点「调试」：

- 节点会在画布上实时变色；
- 顶部显示当前进度与当前节点；
- 人工审核节点会暂停，等待你通过或驳回；
- 可随时终止。

### 6. 查看运行记录与产物

点击「运行记录」：

- 列表展示每次执行的状态、开始时间、完成时间、总耗时；
- 点击详情查看每个节点的结果、输入与上下文和诊断信息；
- 记录文件可直接点击打开，也可以打开整个节点目录。

---

## 📦 工作流产物

每次运行都会在工作区生成独立目录：

```
<workspace>/.novastudio/
└── workflows/<workflowId>/<时间戳>_<runId>/
    ├── run.json
    ├── 01-需求分析/
    │   ├── request.md            # 提交给 Agent 的完整请求（系统提示词 + 任务输入）
    │   └── result.md             # Agent 返回
    └── 02-开发.try-2/            # 重试与首次尝试同级，不额外加层
        ├── request.md
        └── result.md
```

- 节点目录名 = 执行序号 + 节点名称；同名节点不会互相覆盖；
- 首次尝试直接落在节点目录，重试使用同级的 `.try-N` 目录；
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

- **本地优先**：对话、员工、工作流、知识库与运行记录存储在 `~/.novastudio/`；MCP、Skill、CLI 会话与登录复用 Claude Code 的本机配置；
- **知识库透明**：文档以 Markdown 明文存放，可直接用编辑器修改；全文索引保存在本地 SQLite，删除知识库会同步清理索引；
- **进程隔离**：渲染进程关闭 `nodeIntegration`，开启 `contextIsolation` 与 `sandbox`，Agent 子进程仅在主进程启动；
- **工作区隔离**：每个工作流运行有独立产物目录；Claude 节点按员工 MCP / Skill 生成临时投影目录，节点结束即删除；
- **Agent 配置**：直接复用各 CLI 的本机配置（Claude 为 `~/.claude`）；Agent 平台的 Base URL / Key / 模型 / 权限编辑写入 `~/.claude/settings.json`，MCP 写入 `~/.claude.json`，Skill 写入 `~/.claude/skills`；旧版 Nova 主库迁移后归档到 `~/.novastudio/legacy-assets/`；
- **可审计**：每次运行保留提交给 Agent 的请求、Agent 返回与完整事件日志；
- **不会动你的业务目录**：删除工作区只清理 Nova 生成的内容，工作区文件夹本身不会删除。

> [!CAUTION]
> `~/.novastudio/` 存有全部会话与工作流记录，手动删除该目录会清空这些历史数据，且无法从 CLI 侧恢复。

---

## 🗺️ Roadmap

- [x] Claude Code 统一对话
- [x] 数字员工（人设 / MCP / 技能 / 知识库）
- [x] 工作流可视化编排
- [x] 画布内调试与节点实时状态
- [x] 运行记录、节点输入输出与产物
- [x] 工作区级隔离与级联清理
- [x] Skill：统一维护在 Claude 全局技能目录，员工按引用绑定
- [x] MCP：统一写入 Claude 配置，员工按引用绑定
- [x] 知识库：Markdown 管理、全文检索与员工绑定
- [x] Agent 平台：复用本机 CLI 配置，按员工投影 MCP / Skill
- [x] 移除模型选择，统一使用 Claude Code 本机配置里的默认模型
- [ ] 工作流并行分支
- [ ] 中断恢复与断点续跑
- [ ] 知识库文档在线编辑与新建
- [ ] 超大文档后台索引

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

**Nova Studio** · 让每个数字员工都有自己的工位

</div>
