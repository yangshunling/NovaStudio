# 附录 B — 源码文件职责清单

> 用途：AI 复刻时逐文件对照创建，避免遗漏。按目录分组。
> 行数会随代码变化，这里不记录行号。

---

## 1. 根目录配置

| 文件 | 职责 |
|---|---|
| `package.json` | 依赖、脚本、electron-builder 配置、发布渠道 |
| `package-lock.json` | 依赖锁定 |
| `tsconfig.json` | TypeScript 严格配置、路径别名 |
| `electron.vite.config.ts` | 主进程 / preload / 渲染层构建配置 |
| `.npmrc` | Electron / builder 镜像 |
| `.gitignore` | 忽略 `out/`、`release/`、`node_modules/` 等 |
| `README.md` | 产品说明、功能、快速开始、安全、Roadmap |
| `docs/` | 本套工程文档 |

---

## 2. `src/main/` 入口与工具

| 文件 | 职责 |
|---|---|
| `main/index.ts` | 应用入口：窗口、数据库、迁移、残留清理、IPC、更新、知识库索引、退出清理 |
| `main/updater.ts` | electron-updater 状态机、检查 / 下载 / 安装 |
| `main/utils/paths.ts` | `~/.novastudio` 路径、旧目录迁移、路径越界校验 |
| `main/utils/fs.ts` | 原子写、限长读写、文本快照、复制过滤 |

---

## 3. `src/main/agents/`

| 文件 | 职责 |
|---|---|
| `agents/types.ts` | `AgentProvider`、`RunOptions`、`RunSession`、`PreparedAgentRun`、`AgentInvocationInfo` 等运行时契约 |
| `agents/registry.ts` | 自动收集 `agents/*/index.ts`，按 `manifest.order` 排序 |
| `agents/agent-service.ts` | 运行编排、历史缓存、resume 自愈、会话 / 项目清理、超时 |
| `agents/transport.ts` | 子进程 spawn、stdin、环境变量、Windows cmd 引号、进程树终止、行缓冲、ANSI 清洗、`execCli` |
| `agents/line-run.ts` | 行分隔协议运行器：超时、中断、stderr、退出收尾 |
| `agents/probe.ts` | 执行 `<bin> --version` 探测安装 |
| `agents/tool-display.ts` | 工具名 → `kind` / `target` 归一化 |
| `agents/resume-error.ts` | 判断 CLI 诊断是否属于 resume 失效 |
| `agents/claude/manifest.ts` | Claude manifest（id / 能力 / 安装命令） |
| `agents/claude/index.ts` | Claude provider 入口：命令行拼装、系统提示词临时文件、detect、历史、删除、配置摘要 |
| `agents/claude/parse.ts` | stream-json 解码：增量、assistant 归组、工具配对、result 错误 |
| `agents/claude/prepare.ts` | 工作流节点的临时配置投影：settings / credentials / 选中 skills / mcp.json |
| `agents/claude/sessions.ts` | 会话 JSONL 定位、回放、删除、版本号 |
| `agents/claude/settings.ts` | `~/.claude/settings.json` 读取 / 保存、模型 ID 拆分、权限、网络、云厂商 |
| `agents/claude/models.ts` | `/v1/models` 拉取、鉴权头、自定义头解析 |
| `agents/claude/config.ts` | Claude 配置路径、`~/.claude.json` MCP 读写、官方端点判断 |

---

## 4. `src/main/db/`

| 文件 | 职责 |
|---|---|
| `db/sqlite.ts` | 全部建表、索引、FTS5、迁移、项目 / 会话 / 消息 / 员工 / 知识库索引 / 工作流 / 运行 / 节点 / 尝试 / 事件 / 设置 / 自动化 CRUD |

---

## 5. `src/main/ipc/`

| 文件 | 职责 |
|---|---|
| `ipc/index.ts` | 装配 AgentService、WorkflowRunner、Scheduler、TriggerScheduler，注册全部 handler，暴露 stop* |
| `ipc/register.ts` | 类型安全 `handle()` |
| `ipc/push.ts` | 推送窗口、批量通道表、`flushEvents` |
| `ipc/batch.ts` | 与 Electron 无关的批量队列 |
| `ipc/nativeUi.ts` | 文件 / 目录选择框、打开目录兜底 |
| `ipc/handlers/agent.ts` | 检测、配置读写、模型列表、发送、中断 |
| `ipc/handlers/session.ts` | 创建 / 列表 / 详情 / 重命名 / 删除 / 绑定项目 |
| `ipc/handlers/project.ts` | 工作区列表 / 创建 / 删除 / 打开 / Git 状态 |
| `ipc/handlers/file.ts` | 文件读取 / 内嵌图片 / 系统打开 |
| `ipc/handlers/dialog.ts` | 目录选择、`project:listFiles` |
| `ipc/handlers/terminal.ts` | 终端创建（校验 cwd 属于工作区）/ 写 / 调整 / 关闭 |
| `ipc/handlers/settings.ts` | 设置编解码、夹紧、原生外观 |
| `ipc/handlers/app.ts` | 应用与运行时信息 |
| `ipc/handlers/updater.ts` | 更新状态 / 检查 / 下载 / 安装 |
| `ipc/handlers/automation.ts` | 任务列表 / 创建 / 删除 / 重试 / 停止 |
| `ipc/handlers/employee.ts` | 员工 CRUD + 删除保护 |
| `ipc/handlers/mcp.ts` | MCP 列表 / 保存 / 原始 JSON / 删除 / 导入 / 打开 |
| `ipc/handlers/skill.ts` | 技能列表 / 导入 / 删除 / 文件 / 打开 |
| `ipc/handlers/knowledge.ts` | 知识库 CRUD / 文档 / 文件夹 / 上传 / 搜索 / 打开 |
| `ipc/handlers/workflow.ts` | 工作流 CRUD |
| `ipc/handlers/workflow-run.ts` | 启动 / 详情 / 历史 / 续跑 / 删除 / 取消 / 审核 / 产物 / 节点详情 |
| `ipc/handlers/trigger.ts` | 触发器 CRUD + 绑定 |

---

## 6. `src/main/knowledge/`

| 文件 | 职责 |
|---|---|
| `knowledge/catalog.ts` | 知识库扫描、`.kb.json`、文件夹 / 文档 CRUD、上传、预览、写回、索引同步、全文检索 |
| `knowledge/runtime.ts` | 员工知识库解析、系统提示词段落生成 |

---

## 7. `src/main/mcp/` / `skills/` / `migration/`

| 文件 | 职责 |
|---|---|
| `mcp/catalog.ts` | `~/.claude.json` 扫描、解析、校验、保存、改名同步、删除清理、导入 |
| `skills/catalog.ts` | `~/.claude/skills` 扫描、frontmatter、导入、文件树、读写、删除 |
| `migration/legacy-assets.ts` | 旧版 MCP / Skill / Agent 连接迁移到 Claude 配置，归档旧目录 |

---

## 8. `src/main/automation/` / `terminal/` / `files/` / `git/`

| 文件 | 职责 |
|---|---|
| `automation/scheduler.ts` | 任务轮询、并发、恢复、执行、停止、重试 kick |
| `terminal/manager.ts` | node-pty 创建 / 写 / 调整 / 关闭 / 全部回收、shell 解析 |
| `files/access.ts` | 项目文件读取、预览分类、MIME、语言、编码、二进制探测、内嵌图片、路径安全 |
| `git/status.ts` | `git status --porcelain=v1 -z` 解析、分支、状态分类、仓库子目录 |

---

## 9. `src/main/workflow/`

| 文件 | 职责 |
|---|---|
| `workflow/runner.ts` | 工作流引擎：启动 / 互斥 / DAG 调度 / 节点状态机 / 重试 / attempt / round / 审核 / 修改 / 驳回 / 超时 / 续跑 / 取消 / 收尾 / 提示词 |
| `workflow/trigger-scheduler.ts` | 触发器轮询、排队、启动、错误回写 |
| `workflow/artifacts.ts` | 产物目录命名、`.gitignore`、`.novastudio`、临时运行目录清理 |
| `workflow/execution-report.ts` | `execution.md` 生成、脱敏、代码围栏、表格转义 |
| `workflow/cleanup.ts` | 工作流 / 运行 / 工作区级联删除 |

---

## 10. `src/preload/` 与 `src/shared/`

| 文件 | 职责 |
|---|---|
| `preload/index.ts` | `contextBridge` 暴露 `invoke` / `subscribe`，类型来自 IPC 契约 |
| `shared/types.ts` | 全部领域模型与默认设置 |
| `shared/contracts/ipc.ts` | invoke / push 通道契约（唯一真相来源） |
| `shared/contracts/agent.ts` | Agent manifest / 能力 / 设置视图 / 模型 |
| `shared/contracts/skin.ts` | `SkinVariant` |
| `shared/agent-events.ts` | `appendEvent` 合并 / 收敛 |
| `shared/workflow-graph.ts` | 图校验、拓扑排序、直接前驱、警告 |
| `shared/trigger-schedule.ts` | 触发规则清洗、下次时间、摘要 |
| `shared/mcp.ts` | args 拆分、KEY=VALUE 解析 / 格式化 |
| `shared/text.ts` | 换行归一化 |
| `shared/file-kinds.ts` | 文本 / Markdown 扩展名判定（主进程与渲染层共用） |
| `shared/git.ts` | Git 状态字母 / 中文标签 |
| `shared/time.ts` | 补零、当天 / 本周起点、时分、日期时间、时长 |
| `shared/math.ts` | `clamp` |
| `shared/error.ts` | 任意 thrown 值 → 可读信息 |
| `shared/json.ts` | 安全 JSON 解析与 unknown 收窄 |
| `shared/tool-input.ts` | 工具输入目标字段约定与取值 |

---

## 11. `src/renderer/` 根与基础设施

| 文件 | 职责 |
|---|---|
| `renderer/main.tsx` | React 挂载 |
| `renderer/App.tsx` | 应用壳、视图切换、启动副作用、全局弹层 |
| `renderer/env.d.ts` | Vite 类型 |
| `renderer/index.html` | 渲染层入口 HTML |
| `renderer/lib/chat-scroll.ts` | 聊天消息定位：滚动 + 落点校正（问题导航 / 载入更早共用） |
| `renderer/lib/ipc.ts` | IPC 客户端，语义化方法 + 订阅 |
| `renderer/lib/popup.ts` | 浮层定位：上下翻转、视口收拢、右键菜单坐标 |
| `renderer/lib/shiki.ts` | Shiki 单例、语言 / 主题预加载 |
| `renderer/lib/utils.ts` | `newId`、`toMessage`、`truncateText`、`firstText`、`isToolResultError` 等 |
| `renderer/lib/workflow/status.ts` | 节点状态展示配置 |
| `renderer/hooks/useAgentStream.ts` | 订阅 agent / automation 事件 |
| `renderer/hooks/useDismissableLayer.ts` | 浮层关闭：外部点击 / Esc / 滚动 / 缩放 |
| `renderer/hooks/useFilteredList.ts` | 列表关键字筛选 |
| `renderer/hooks/useLoad.ts` | 通用加载 hook |
| `renderer/hooks/useTheme.ts` | 皮肤 / 字号状态与 DOM 应用 |
| `renderer/hooks/useThrottledValue.ts` | 流式值节流 + Markdown 间隔 |
| `renderer/styles/index.css` | Tailwind、派生字号、排版角色、`@theme inline` 映射、`ui-*` 原语 |
| `renderer/stores/chat.ts` | 会话 / 消息 / 流式 / 视图 / 设置弹框 |
| `renderer/stores/automation.ts` | 任务列表与推送更新 |
| `renderer/stores/assets.ts` | 资产预加载与刷新 |
| `renderer/stores/employees.ts` | 员工列表 |
| `renderer/stores/terminal.ts` | 终端标签、活动、重启 |
| `renderer/stores/fileViewer.ts` | 文件标签 |
| `renderer/stores/toast.ts` | 全局提醒 |
| `renderer/stores/confirm.ts` | 全局确认框 |

---

## 12. `src/renderer/skins/`

| 文件 | 职责 |
|---|---|
| `skins/contract.ts` | 必填 / 可选 / 派生 token 清单 |
| `skins/registry.ts` | 自动收集皮肤，默认皮肤，按 id 查找 |
| `skins/validate.ts` | 开发期探针校验 |
| `skins/_base.css` | 共享形状默认值，`:where([data-theme])` |
| `skins/classic-day/index.ts` | 经典昼元数据 |
| `skins/classic-day/tokens.css` | 经典昼 token |
| `skins/classic-night/index.ts` | 经典夜元数据 |
| `skins/classic-night/tokens.css` | 经典夜 token |

---

## 13. `src/renderer/components/` 通用 UI

| 文件 | 职责 |
|---|---|
| `ui/AgentPill.tsx` | Agent 标识胶囊 |
| `ui/Button.tsx` | 通用按钮 |
| `ui/cardStyles.ts` | 卡片样式常量 |
| `ui/Combobox.tsx` | 可搜索下拉 |
| `ui/ConfirmDeleteButton.tsx` | 删除确认按钮 |
| `ui/ConfirmDialog.tsx` | 全局确认框 |
| `ui/Dialog.tsx` | 对话框 |
| `ui/Drawer.tsx` | 右侧抽屉 |
| `ui/EmptyState.tsx` | 空态 / 加载 / 错误 / 过滤空 |
| `ui/ErrorBoundary.tsx` | 渲染错误兜底 |
| `ui/Field.tsx` | 表单行 / 内联输入 |
| `ui/FileTypeIcon.tsx` | 文件图标 |
| `ui/FolderTypeIcon.tsx` | 文件夹图标 |
| `ui/IconButton.tsx` | 圆形图标按钮（尺寸 / 色调 / 禁用统一） |
| `ui/ListPane.tsx` | 左侧列表栏 |
| `ui/MarkdownRenderer.tsx` | Markdown + GFM + Shiki |
| `ui/Menu.tsx` | 右键菜单 |
| `ui/MessageAvatar.tsx` | Agent / Nova 头像 |
| `ui/Modal.tsx` | 模态框 |
| `ui/NoWorkspaceState.tsx` | 无工作区空态 |
| `ui/OptionChips.tsx` | 多选芯片 |
| `ui/overlayStack.ts` | 弹层层级 |
| `ui/Page.tsx` | 页面骨架 / 顶栏 / 工具栏 |
| `ui/Pill.tsx` | 状态标签 |
| `ui/SearchInput.tsx` | 搜索框 |
| `ui/SegmentedTabs.tsx` | 分段切换 |
| `ui/Select.tsx` | 下拉 |
| `ui/StatusDot.tsx` | 状态点 |
| `ui/StreamingIndicator.tsx` | 流式指示 |
| `ui/ToastViewport.tsx` | 提醒容器 |
| `ui/Toggle.tsx` | 开关 |
| `ui/UserBubble.tsx` | 用户气泡 |
| `ui/vscodeFileIcons.ts` | VSCode 图标数据（生成） |
| `ui/VscodeIcon.tsx` | 图标组件 |
| `asset/AssetUi.tsx` | 资产页通用布局 |
| `asset/EditorUi.tsx` | 资产编辑通用布局 |

---

## 14. `src/renderer/components/` 业务页面

### app

| 文件 | 职责 |
|---|---|
| `app/Sidebar.tsx` | 导航、活跃运行徽标、设置入口 |
| `app/SettingsModal.tsx` | 设置弹框 |
| `app/ThemeToggle.tsx` | 昼夜切换 |

### chat

| 文件 | 职责 |
|---|---|
| `chat/SessionsView.tsx` | 会话页两栏布局 |
| `chat/SessionListPanel.tsx` | 会话列表、右键菜单、重命名 |
| `chat/CenterPane.tsx` | 中间内容：对话 / 文件标签 |
| `chat/CenterTabs.tsx` | 标签栏 |
| `chat/ChatArea.tsx` | 对话区、输入、@ 提及、停止 |
| `chat/AssistantMessageList.tsx` | assistant-ui 适配、part 转换、工具配对、节流 |
| `chat/MessageList.tsx` | 通用消息渲染（任务中心也用） |
| `chat/AgentSelector.tsx` | Agent 选择 |
| `chat/ProjectSelector.tsx` | 工作区绑定 / 解绑（输入框旁触发器） |
| `chat/WorkspacePicker.tsx` | `#` 快捷切换工作区：触发、过滤、键盘 |
| `chat/WorkspaceMenu.tsx` | 工作区菜单唯一实现：条目构建 + 弹窗（两条入口共用） |
| `chat/MentionPicker.tsx` | @ 引用选择 hook 与弹窗（文件 / 工具 / 技能 / 提示词 / 知识库） |

### workflows

| 文件 | 职责 |
|---|---|
| `workflows/WorkflowsView.tsx` | 工作区 + 工作流卡片、运行 / 调试 / 重命名 / 复制 / 删除 / 绑定触发器 |
| `workflows/WorkflowEditor.tsx` | 编辑器状态、保存、撤销 / 重做、校验、调试、快捷键 |
| `workflows/WorkflowCanvas.tsx` | 自绘画布：拖拽 / 缩放 / 平移 / 连线 / 多选 / 状态 / 问题 |
| `workflows/WorkflowDebugPanel.tsx` | 画布内调试状态栏、审核入口 |
| `workflows/WorkflowRunView.tsx` | 运行详情：节点列表 + 对话 / 结果 / 产物 / 提示 / 执行信息 |
| `workflows/WorkflowRunHistoryView.tsx` | 运行记录列表 |
| `workflows/defaults.ts` | 新建工作流默认图 |

### employees / skills / mcp / knowledge

| 文件 | 职责 |
|---|---|
| `employees/EmployeesView.tsx` | 员工卡片画廊 |
| `employees/EmployeeDrawer.tsx` | 员工编辑抽屉 |
| `employees/EmployeeAvatar.tsx` | 头像 |
| `employees/AssetBindTab.tsx` | 技能 / MCP / 知识库绑定列表（卡片、开关、孤儿区） |
| `employees/BindUi.tsx` | 绑定行通用 UI |
| `employees/mcp/McpTab.tsx` | MCP 绑定页签 |
| `employees/skills/SkillsTab.tsx` | Skill 绑定页签 |
| `employees/knowledge/KnowledgeTab.tsx` | 知识库绑定页签 |
| `skills/SkillsView.tsx` | 技能列表、抽屉、文件树、编辑器 |
| `mcp/McpView.tsx` | MCP 列表、抽屉、导入 |
| `mcp/presentation.ts` | MCP 展示辅助 |
| `knowledge/KnowledgeView.tsx` | 知识库两栏、文档、搜索、预览、表单 |

### workspaces / automation / triggers / agents / terminal / files

| 文件 | 职责 |
|---|---|
| `workspaces/WorkspacesView.tsx` | 工作区卡片、新建 / 删除、统计 |
| `workspaces/WorkspacePanel.tsx` | 文件面板、懒加载、Git 状态覆盖、宽度持久化 |
| `automation/AutomationView.tsx` | 任务看板 |
| `automation/BoardColumn.tsx` | 看板列 |
| `automation/TaskCard.tsx` | 任务卡片 |
| `automation/TaskCreateModal.tsx` | 新建任务 |
| `automation/TaskDetailDrawer.tsx` | 任务详情 |
| `triggers/TriggersView.tsx` | 触发器列表、表单、绑定 |
| `agents/AgentsView.tsx` | Agent 配置 |
| `terminal/TerminalsView.tsx` | 终端页布局、工作区列表 |
| `terminal/TerminalView.tsx` | xterm 实例、PTY 生命周期、剪贴板、字号 |
| `files/FilePreview.tsx` | 文件预览各类型 |

---

## 15. 测试

| 文件 | 职责 |
|---|---|
| `tests/agent-events.test.ts` | 事件合并 / 收敛 |
| `tests/parse.test.ts` | Claude 解码 + 收敛 |
| `tests/protocol.test.ts` | 行协议 / 退出 / Windows / resume 文案 |
| `tests/trigger-schedule.test.ts` | 触发规则 |
| `tests/graph.test.ts` | 图校验 |
| `tests/mcp.test.ts` | MCP 纯函数 |
| `tests/execution-report.test.ts` | 执行报告 / 脱敏 |
| `tests/batch.test.ts` | 批量队列 |

---

## 16. 脚本与资源

| 文件 | 职责 |
|---|---|
| `scripts/verify-skin-tokens.mjs` | 构建后皮肤契约校验 |
| `scripts/verify-typography.mjs` | 排版守卫：字号档位 / 字体族 / 废弃类扫描 |
| `scripts/generate-vscode-file-icons.mjs` | 生成 VSCode 图标数据 |
| `resources/logo.png` | 应用 / 安装包图标 |
| `resources/banner.svg` | README 横幅 |
| `resources/NOTICE.md` | 第三方许可 |
| `resources/preview/` | 界面预览截图 |
