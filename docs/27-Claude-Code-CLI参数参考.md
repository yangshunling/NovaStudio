# 27 Claude Code CLI 参数参考

> 适用版本：Claude Code **2.1.325**
> 采集方式：本机 `claude --help`、各子命令 `--help` 逐条实测（2026-11-14），并探测了帮助里未列出的隐藏参数。
> Claude Code 迭代较快，参数会增删。排查问题前先跑一次 `claude --help` 对齐，本文与本地输出不一致时以本地为准。

---

## 1. 调用形态

```bash
claude [options] [command] [prompt]
```

| 形态 | 示例 | 说明 |
|---|---|---|
| 交互会话 | `claude`、`claude "解释这个报错"` | 默认行为，进入 TUI |
| 非交互 / 管道 | `claude -p "总结这个 diff"` | 打印结果后退出，可接管道 |
| 子命令 | `claude mcp list`、`claude plugin install xxx` | 管理类操作，不进入会话 |

`prompt` 是位置参数，直接写在最后即可；带空格的提示词要加引号。

**`-p/--print` 的两个副作用**（官方 help 明确说明）：

- 跳过工作区信任对话框。只在你信任的目录里用 `-p`，或用于 stdout 非 TTY 的管道 / CI 场景。
- 校验失败的 settings 文件会被**静默忽略**，不会弹错误。

---

## 2. 全局参数

### 2.1 会话入口与生命周期

| 参数 | 取值 | 说明 |
|---|---|---|
| `-p, --print` | — | 打印响应后退出，不进入交互。管道、CI、脚本的基本开关 |
| `-c, --continue` | — | 继续当前目录**最近**一次会话 |
| `-r, --resume [value]` | 会话 ID / 名称 / 搜索词 | 恢复指定会话；不带值时打开交互选择器，带值时可按名称或 ID 匹配 |
| `--fork-session` | — | 恢复时新建会话 ID，不污染原会话。配合 `--resume` / `--continue` |
| `--from-pr [value]` | PR 号 / URL / 搜索词 | 恢复与某个 PR 关联的会话；不带值打开选择器 |
| `--session-id <uuid>` | 合法 UUID | 指定本次会话的 ID，便于外部系统预分配 |
| `-n, --name <name>` | 字符串 | 会话显示名，出现在输入框、`/resume` 列表和终端标题里 |
| `--bg, --background` | — | 后台起会话并立即返回，打印短 ID，供 `attach` / `logs` / `stop` / `rm` 使用。与 `--resume <id>` 同用会在同一 ID 下后台续跑 |
| `--no-session-persistence` | — | 不落盘、不可恢复。**仅 `--print` 下有效** |
| `--teleport [session]` | 会话 ID | 恢复 teleport 会话 |
| `--cloud [description\|session_id\|url]` | 描述 / 会话 ID / URL | 创建云会话，或按 ID / claude.ai/code URL 接入已有云会话 |
| `--environment <environment_id>` | `ccpool_...` | 在指定的自托管环境上创建云会话 |
| `--file <specs...>` | `file_id:relative_path` | 启动时下载文件资源，如 `--file file_abc:doc.txt file_def:img.png` |
| `-w, --worktree [name]` | 名称 | 为本次会话新建 git worktree |
| `--tmux` | — | 为 worktree 建 tmux 会话，**依赖 `--worktree`**；有 iTerm2 时用原生分屏，`--tmux=classic` 用传统 tmux |

### 2.2 模型与推理

| 参数 | 取值 | 说明 |
|---|---|---|
| `--model <model>` | 别名（`fable` / `opus` / `sonnet`）或完整模型名 | 本次会话使用的模型，覆盖配置 |
| `--fallback-model <model>` | 单个或逗号分隔的多个模型 | 主模型过载 / 不可用时按顺序自动降级。每个用户回合开始时重试主模型 |
| `--effort <level>` | `low` `medium` `high` `xhigh` `max` | 本次会话的推理强度。档位越高越慢越贵 |
| `--autocompact <auto\|tokens>` | `auto` 或 `100k`–`1M` | 自动压缩窗口大小 |
| `--max-budget-usd <amount>` | 美元金额 | API 调用费用上限。**仅 `--print` 下有效** |
| `--betas <betas...>` | beta 头名称 | 附加 beta 请求头，仅 API Key 用户可用 |
| `--prompt-suggestions [value]` | `true/false/1/0/yes/no/on/off` | 预测下一条用户输入。print / SDK 模式下每回合发 `prompt_suggestion` 消息 |

### 2.3 权限、工具与安全边界

| 参数 | 取值 | 说明 |
|---|---|---|
| `--permission-mode <mode>` | `acceptEdits` `auto` `bypassPermissions` `manual` `dontAsk` `plan` | 会话级权限模式 |
| `--permission-prompts <target>` | `host`（默认）/ `none` | `--print` 下由谁回答权限询问：`host` 交给 SDK 宿主或 `--permission-prompt-tool`；`none` 表示没人回答，凡是需要询问的一律自动拒绝（权限模式本身仍然生效） |
| `--allowedTools, --allowed-tools <tools...>` | 逗号或空格分隔的工具名 | 允许清单，支持 `Bash(git *)` 这类模式匹配 |
| `--disallowedTools, --disallowed-tools <tools...>` | 同上 | 拒绝清单，优先级高于允许清单 |
| `--tools <tools...>` | `""` / `default` / 工具名列表 | 限定可用的**内置**工具集。`""` 全关，`default` 默认集，或写 `Bash,Edit,Read` |
| `--add-dir <directories...>` | 目录路径 | 追加允许工具访问的目录 |
| `--dangerously-skip-permissions` | — | 跳过**全部**权限检查。官方建议仅用于无外网沙箱 |
| `--allow-dangerously-skip-permissions` | — | 让绕过权限“可以作为选项”，但默认不启用。同样只建议无外网沙箱 |
| `--restricted` | — | 受限模式：移除 Bash、PowerShell 等执行代码的内置工具与 WebFetch（除非 `--tools` 显式点名）；忽略 user / project / local 配置（managed 与 `--settings` 仍生效，加 `--strict-mcp-config` 才跳过 MCP）；文件工具限制在工作目录（含 `--add-dir`）；拒绝 `bypassPermissions`；写 settings、git、工具配置必须由人或配置的处理器批准 |
| `--disable-slash-commands` | — | 禁用全部 skill 与命令 |
| `--bare` | — | 极简模式：跳过 settings 与插件定义的 hooks、LSP、插件同步、归因、auto-memory、后台预取、keychain 读取、CLAUDE.md 自动发现；设 `CLAUDE_CODE_SIMPLE=1`。Anthropic 鉴权只认 `ANTHROPIC_API_KEY` 或 `--settings` 里的 `apiKeyHelper`，OAuth 与 keychain 一律不读；第三方 provider 用各自的凭证。skill 仍可通过 `/skill-name` 解析。上下文需显式给：`--system-prompt-file`、`--append-system-prompt-file`、`--add-dir`、`--mcp-config`、`--settings`、`--agents`、`--plugin-dir` |
| `--safe-mode` | — | 关闭所有自定义（CLAUDE.md、skills、插件、hooks、MCP、命令、agents、输出风格、workflows、主题、键位等），用于排查配置损坏；设 `CLAUDE_CODE_SAFE_MODE=1`。管理员策略设置仍生效，鉴权、模型、内置工具和权限正常 |

### 2.4 上下文与提示词

| 参数 | 取值 | 说明 |
|---|---|---|
| `--system-prompt <prompt>` | 提示词文本 | 整体替换默认系统提示词 |
| `--system-prompt-file <file>` | 文件路径 | 从文件读取系统提示词。**隐藏参数**，见 2.9 |
| `--append-system-prompt <prompt>` | 提示词文本 | 在默认系统提示词后追加 |
| `--append-system-prompt-file <file>` | 文件路径 | 从文件读取追加内容。**隐藏参数**，见 2.9 |
| `--system-prompt-snapshot <on\|off>` | `on`（默认）/ `off` | `on`：会话首次请求时渲染并记录系统提示词（包含本次的 `--system-prompt` / `--append-system-prompt`），之后每个请求和恢复都原样发送，直到压缩；`off`：每次请求都重新渲染，适合反复调提示词。`--bare` 下的云 / 后台会话默认是 `off` |
| `--exclude-dynamic-system-prompt-sections` | — | 把 cwd、环境信息、memory 路径、git status 等“每机器不同”的段落从系统提示词移到第一条用户消息，提高跨用户 prompt cache 命中率。**仅在默认系统提示词下生效**，与 `--system-prompt` 同用会被忽略 |
| `--agents <json-or-file>` | JSON 对象 / 文件路径 | 定义临时自定义 agent，如 `{"reviewer":{"description":"Reviews code","prompt":"You are a code reviewer"}}`；`--print` 下可传 JSON 文件路径 |
| `--agent <agent>` | agent 名称 | 指定本次会话使用的 agent，覆盖 `agent` 配置 |
| `--brief` | — | 启用 `SendUserMessage` 工具，供 agent 主动给用户发消息 |

### 2.5 输出与流式协议

| 参数 | 取值 | 说明 |
|---|---|---|
| `--output-format <format>` | `text`（默认）/ `json` / `stream-json` | **仅 `--print`**。`json` 为单个结果对象，`stream-json` 为逐行事件流 |
| `--input-format <format>` | `text`（默认）/ `stream-json` | **仅 `--print`**。`stream-json` 支持实时流式输入 |
| `--include-partial-messages` | — | 输出 partial message 分片（`content_block_delta`）。**仅 `--print` + `stream-json`** |
| `--include-hook-events` | — | 在事件流里输出全部 hook 生命周期事件。**仅 `stream-json`** |
| `--replay-user-messages` | — | 把 stdin 的用户消息回显到 stdout 作确认。**需 `--input-format=stream-json` 且 `--output-format=stream-json`** |
| `--forward-subagent-text` | — | 把子 agent 的文本与 thinking 块作为带 `parent_tool_use_id` 的消息转发。**仅 `--print` + `stream-json`** |
| `--json-schema <schema>` | JSON Schema | 用 schema 校验结构化输出。**仅 `--print`** |
| `--verbose` | — | 覆盖配置里的 verbose 设置。`-p` + `stream-json` 通常必须带上 |
| `--ax-screen-reader` | — | 无障碍输出：纯文本、无装饰边框与动画 |

### 2.6 扩展加载（配置 / MCP / 插件）

| 参数 | 取值 | 说明 |
|---|---|---|
| `--settings <file-or-json>` | 文件路径或 JSON 字符串 | 追加加载配置 |
| `--setting-sources <sources>` | 逗号分隔：`user` `project` `local` | 限定加载哪些配置来源 |
| `--mcp-config <configs...>` | JSON 文件或 JSON 字符串，空格分隔 | 加载 MCP 服务器配置 |
| `--strict-mcp-config` | — | 只用 `--mcp-config` 提供的 MCP，忽略其余全部 MCP 配置 |
| `--plugin-dir <path>` | 目录或 `.zip` | 仅本次会话加载插件；传“插件目录的目录”会逐个加载子项。可重复 |
| `--plugin-url <url>` | URL | 仅本次会话从 URL 拉取插件 zip。可重复 |

### 2.7 环境、界面与远程

| 参数 | 取值 | 说明 |
|---|---|---|
| `--ide` | — | 启动时若恰好有一个可用 IDE，自动连接 |
| `--chrome` / `--no-chrome` | — | 启用 / 禁用 Claude in Chrome 集成 |
| `--desktop` | — | 在 Claude Desktop 中打开；配合 `--continue` 或 `--resume <id>` 选择会话 |
| `--remote-control [name]` | 名称（可选） | 启动交互会话并开启 Remote Control，可命名 |
| `--remote-control-session-name-prefix <prefix>` | 前缀 | Remote Control 自动生成的会话名前缀，默认主机名 |

### 2.8 调试与诊断

| 参数 | 取值 | 说明 |
|---|---|---|
| `-d, --debug [filter]` | 分类过滤器 | 开启调试，可按分类过滤：`--debug=hooks,mcp`，`--debug='!hooks,!mcp'` 表示排除 |
| `--debug-file <path>` | 文件路径 | 调试日志写入指定文件，**隐含开启 debug** |
| `-h, --help` | — | 帮助 |
| `-v, --version` | — | 版本号 |

### 2.9 未在 `--help` 中列出的参数

以下参数本地 CLI 能识别（传空值时报 `argument missing` 而不是 `unknown option`），但主帮助里没有列出。它们被 `--bare`、`--permission-prompts` 的帮助文本间接引用，属于**可用但未文档化**，跨版本稳定性弱，建议只在确有需要时使用。

| 参数 | 取值 | 说明 |
|---|---|---|
| `--system-prompt-file <file>` | 文件路径 | 从文件读系统提示词，等价于把 `--system-prompt` 的内容放进文件。适合长提示词、避免命令行转义 |
| `--append-system-prompt-file <file>` | 文件路径 | 从文件读追加提示词 |
| `--permission-prompt-tool <tool>` | 如 `stdio` | 指定处理权限询问的 MCP 工具。SDK / 宿主接管 `can_use_tool` 时使用。本项目适配层即通过 `--permission-prompt-tool stdio` 让 CLI 把授权请求写回 stdin |
| `--max-turns <turns>` | 整数 | 限制 agent 循环的最大回合数，超出即停。CI 防跑飞常用 |
| `--resume-session-at <message id>` | 消息 ID | 从指定消息点恢复会话（回滚到某个节点） |

---

## 3. 子命令

### 3.1 后台会话管理

| 子命令 | 说明 |
|---|---|
| `claude agents` | 管理后台 agent 视图 |
| `claude attach <id\|name>` | 在当前终端打开后台会话；`←` 回到 agent 视图，`Ctrl+Z` 退回 shell，会话都继续运行。名称可只写一部分，带空格要加引号 |
| `claude logs <id\|name>` | 打印后台会话最近的终端输出 |
| `claude stop <id>`（别名 `kill`） | 停止后台会话，会话内容保留，之后可 `attach` 或 `--resume` |
| `claude respawn <id>\|--all` | 用当前 Claude 二进制重启后台会话 |
| `claude rm <id>` | 安全前提下移除后台会话并删除其 worktree；会话本身保留，可由 `--resume` 找回。对已退出的会话也有效 |

`agents` 的参数：

| 参数 | 说明 |
|---|---|
| `--add-dir <directory>` | 派发的会话额外可访问目录，可重复 |
| `--agent <agent>` | agent 视图派发会话的默认 agent |
| `--all` | 配合 `--json`，同时列出已完成的会话 |
| `--allow-dangerously-skip-permissions` | 让派发会话**可以**选择绕过权限，但不默认启用 |
| `--cwd <path>` | 只显示在该路径下启动的后台会话 |
| `--dangerously-skip-permissions` | 等价于 `--permission-mode bypassPermissions` |
| `--effort <level>` | 派发会话的默认推理强度 |
| `--json` | 以 JSON 数组输出所有活跃会话后退出，不需要 TTY，适合脚本 |
| `--mcp-config <config>` | 派发会话使用的 MCP 配置，可重复 |
| `--model <model>` | 派发会话的默认模型 |
| `--permission-mode <mode>` | 派发会话的默认权限模式 |
| `--plugin-dir <path>` | agent 视图及派发会话加载的插件目录，可重复 |
| `--restricted` | 派发会话以受限模式启动 |
| `--setting-sources <sources>` | 加载的配置来源 |
| `--settings <file-or-json>` | 应用的配置文件或 JSON |
| `--strict-mcp-config` | 派发会话只用 `--mcp-config` 的 MCP |

`rm` 的两个高级参数：

| 参数 | 说明 |
|---|---|
| `--discard-unpushed <commit>@<worktree-id>` | 连同 worktree 的未推送提交与未提交改动一起丢弃；值用上一次 `claude rm <id>` 报告的内容 |
| `--force-remove-worktree <worktree-id>` | WorktreeRemove hook 或 git 删不掉时强制删目录；要求仓库仍把它登记为 worktree，且已跟踪文件无未提交改动，分支保留 |

### 3.2 `claude mcp`

| 子命令 | 说明 |
|---|---|
| `add [options] <name> <commandOrUrl> [args...]` | 添加 MCP 服务器 |
| `add-json [options] <name> <json>` | 用 JSON 字符串添加（stdio / SSE / HTTP / WebSocket） |
| `add-from-claude-desktop [options]` | 从 Claude Desktop 导入（仅 Mac 与 WSL） |
| `get <name>` | 查看某个服务器详情。未批准的 `.mcp.json` 服务器显示为 ⏸ Pending approval，不会连接 |
| `list` | 列出全部服务器；已批准的会做健康检查（本项目中禁用的除外） |
| `login [options] <name>` | 对 HTTP / SSE / claude.ai 连接器做 OAuth 登录 |
| `logout <name>` | 清除该服务器保存的 OAuth 凭证 |
| `remove [options] <name>` | 移除服务器 |
| `reset-project-choices` | 重置本项目内所有 `.mcp.json` 服务器的批准 / 拒绝记录 |
| `serve [options]` | 把 Claude Code 自身作为 MCP 服务器启动 |

`mcp add` 参数：

| 参数 | 说明 |
|---|---|
| `--callback-port <port>` | OAuth 回调固定端口，用于要求预注册 redirect URI 的服务器 |
| `--client-id <clientId>` | HTTP / SSE 服务器的 OAuth client ID |
| `--client-secret` | 交互式输入 OAuth client secret，或走 `MCP_CLIENT_SECRET` 环境变量 |
| `-e, --env <env...>` | 环境变量，如 `-e API_KEY=xxx` |
| `-H, --header <header...>` | HTTP / SSE 请求头，可重复 |
| `-s, --scope <scope>` | `local`（默认）/ `user` / `project` |
| `-t, --transport <transport>` | `stdio`（默认）/ `sse` / `http` |

`add-json`、`add-from-claude-desktop` 支持 `-s/--scope`；`add-json` 另有 `--client-secret`。
`mcp login` 支持 `--no-browser`：打印授权 URL 而不是拉起浏览器，适合 SSH / 无头环境，之后把跳转 URL 粘回来。
`mcp serve` 支持 `-d/--debug`、`--verbose`。

**三种 scope 的实际差别**：

- `local`：只对当前项目和你本人生效，写在 `~/.claude.json` 的 `projects.<路径>.mcpServers`。
- `project`：写入仓库根的 `.mcp.json`，随仓库共享，首次使用要批准，批准记录也在 `~/.claude.json` 的 `enabledMcpjsonServers`。
- `user`：全局生效，写在 `~/.claude.json` 顶层 `mcpServers`。同名时项目级覆盖全局级。

### 3.3 `claude plugin`（别名 `plugins`）

| 子命令 | 说明 |
|---|---|
| `install, i [options] <plugin>` | 从市场安装，`plugin@marketplace` 指定市场 |
| `uninstall, remove [options] <plugin>` | 卸载 |
| `list [options]` | 列出已安装插件 |
| `enable [options] <plugin>` / `disable [options] [plugin]` | 启用 / 禁用；`disable -a` 全部禁用 |
| `update [options] <plugin>` | 更新，需重启会话生效 |
| `details [options] <name>` | 组件清单与预估 token 成本 |
| `configure [options] <plugin>` | 查看 / 写入插件选项 |
| `init, new [options] <name>` | 在 `~/.claude/skills/<name>/` 脚手架新插件 |
| `validate [options] <path>` | 校验插件 / 市场清单，或目录内的 skills、agents、commands |
| `test [dir]` | 跑插件的 `*.test.ts(x)`，从 `claude-code/testing` 引入测试工具 |
| `eval [options] [target]` | 跑插件评测集，输出打分结果 |
| `prune, autoremove [options]` | 清理不再需要的自动安装依赖 |
| `tag [options] [path]` | 为插件发布打 `{name}--v{version}` git tag |
| `restore-set-aside [options] <plugin>` | 恢复被组织策略换源时暂存的选项与密钥 |
| `marketplace` | 市场管理，见下 |

`install` 常用参数：`-s/--scope user|project|local`（默认 user）、`--marketplace <source>`（owner/repo、git/https URL 或本地路径，未添加会先添加）、`--config <key=value>`（可重复）、`--json`、`-y/--yes`、`--accept-command <sha256>`。

`uninstall`：`-s/--scope`、`--keep-data`、`--prune`、`--json`、`-y`。
`list`：`--json`、`--available`（需 `--json`）、`--data-size [plugin]`（需 `--json`）。
`enable` / `disable`：`--json`、`-s/--scope`；`disable` 另有 `-a/--all`。
`configure`：`--json`、`--values-stdin`（从 stdin 读 JSON 对象，缺省项保持原值）。
`init`：`--author`、`--author-email`、`--description`、`-f/--force`、`--with <components...>`（`skills agents hooks mcp lsp output-style channel`）。
`validate`：`--json`、`--strict`（警告即失败，CI 用）、`--profile directory`（按插件目录的提交要求检查）。
`prune`：`-s/--scope`、`--dry-run`、`-y`。
`tag`：`-m/--message <msg>`、`--push`、`--remote <name>`（默认 origin）、`-f/--force`、`--dry-run`。
`restore-set-aside`：`--discard`（改为删除暂存内容）。

`eval` 主要参数：`--case <glob>`、`--tag <tag...>`、`--runs <n>`、`-j/--concurrency <1-8>`、`--model`、`--judge-model`、`--threshold <0..1>`、`--max-cost-usd`、`--json [path]`、`--report <path>`、`--eval-dir <dir>`、`--output-dir <dir>`、`--mocks record|off`、`--allow-real-servers`、`--allow-tools`、`--disallow-tools`、`--scaffold`、`--no-scaffold`、`--trust-plugin`、`--no-publish`、`--publish-report`、`--keep-temp`、`--ablation none|with-without`。子命令 `eval init [--bare <name>]` 用于生成评测套件。

`plugin marketplace`：

| 子命令 | 参数 |
|---|---|
| `add <source>` | `--scope user\|project\|local`、`--sparse <paths...>`（monorepo 稀疏检出）、`--claudeai`、`--json` |
| `list` | `--json` |
| `remove, rm <name>` | `--scope`（省略则从所有 scope 移除）、`--json` |
| `update [name]` | 省略名称则全部更新；`--json` |

### 3.4 `claude auth` / `setup-token`

| 子命令 | 参数 | 说明 |
|---|---|---|
| `auth login` | `--claudeai`（默认）、`--console`、`--email <email>`、`--sso` | 登录。`--console` 走 API 计费；`--sso` 强制 SSO 流程 |
| `auth logout` | — | 登出 |
| `auth status` | `--json`（默认）/ `--text` | 查看登录状态 |
| `setup-token` | — | 生成长期有效的令牌（需要 Claude 订阅） |

### 3.5 `claude auto-mode`

| 子命令 | 参数 | 说明 |
|---|---|---|
| `config` | — | 打印生效的 auto mode 配置 JSON |
| `critique` | `--model <model>` | 让 AI 点评自定义 auto mode 规则 |
| `defaults` | `--label <prefix>` | 打印默认的 environment / allow / soft_deny / hard_deny 规则 |
| `reset` | `-y/--yes` | 删除用户配置里的 `autoMode` 段，恢复出厂 |

### 3.6 安装与诊断

| 子命令 | 参数 | 说明 |
|---|---|---|
| `doctor` | — | 检查安装健康度；读当前目录配置时不需要信任确认。完整检查用会话内 `/doctor` |
| `install [target]` | `--force`、target 可为 `stable` / `latest` / 具体版本 | 安装原生构建 |
| `update`（别名 `upgrade`） | — | 检查并安装更新；包管理器安装的版本走包管理器更新 |

### 3.7 其他

| 子命令 | 参数 | 说明 |
|---|---|---|
| `import [source]` | source：`codex` / `gemini` / `cursor`；`--dry-run`、`--yes` | 从其他 AI 编程工具导入配置 |
| `purge [path]` | `--all`、`--dry-run`、`-i/--interactive`、`-y/--yes` | 删除某项目的 Claude Code 数据（transcripts、tasks、文件历史、`~/.claude.json` 条目），仅本机 |
| `gateway` | `--config <path>` | 运行企业鉴权 / 遥测网关，配置为 YAML |
| `ultrareview [target]` | `--json`、`--post` / `--no-post`、`--timeout <minutes>`（默认 45）、`--trust-workspace` | 云端多 agent 代码评审当前分支（或 PR 号 / 基线分支），默认不把结果发到 PR |

---

## 4. 常用组合

### 4.1 CI / 脚本里的一次性调用

```bash
claude -p "把 src 下未使用的 import 清掉" \
  --output-format json \
  --max-turns 10 \
  --allowedTools "Read Edit Bash(git diff *)" \
  --permission-mode acceptEdits
```

### 4.2 流式消费（本项目适配层的用法）

```bash
claude -p --output-format stream-json --verbose --include-partial-messages
```

### 4.3 恢复并分叉

```bash
claude -r <session-id> --fork-session
```

### 4.4 后台跑长任务

```bash
claude --bg --name "refactor-auth" "重构 auth 模块"
claude agents --json
claude logs refactor-auth
claude attach refactor-auth
claude stop refactor-auth
```

### 4.5 完全隔离地跑

```bash
claude --safe-mode --restricted --strict-mcp-config -p "..."
```

### 4.6 排查配置问题

```bash
claude --safe-mode
claude doctor
claude --debug=hooks,mcp --debug-file ./claude-debug.log
```

### 4.7 指定项目级 MCP 与插件

```bash
claude --mcp-config ./.mcp.ci.json --strict-mcp-config \
       --plugin-dir ./plugins --setting-sources project
```

---

## 5. 参数间的硬约束（速查）

| 约束 | 说明 |
|---|---|
| `--print` 专属 | `--output-format`、`--input-format`、`--include-partial-messages`、`--json-schema`、`--max-budget-usd`、`--no-session-persistence`、`--permission-prompts` 实际语义、`--forward-subagent-text` |
| `stream-json` 专属 | `--include-partial-messages`（还需 `-p`）、`--include-hook-events`、`--replay-user-messages`（要求输入输出都是 stream-json） |
| 依赖其他参数 | `--tmux` 需要 `--worktree` |
| 互斥 / 覆盖 | `--strict-mcp-config` 会屏蔽除 `--mcp-config` 外的所有 MCP；`--restricted` 忽略 user/project/local 配置；`--safe-mode` 关闭全部自定义 |
| 只对默认提示词生效 | `--exclude-dynamic-system-prompt-sections` 与 `--system-prompt` 同用会被忽略 |
| 认证限制 | `--betas` 仅 API Key 用户；`--bare` 下只认 `ANTHROPIC_API_KEY` / `apiKeyHelper` |

---

## 6. 与本项目适配层的对应关系

`src/main/agents/claude/index.ts` 拼装的参数及其用途见《06 Claude Code 适配层》第 2 节。对应关系如下：

| 适配层用途 | CLI 参数 |
|---|---|
| 一次性非交互执行 | `-p` |
| 事件流解析 | `--output-format stream-json` |
| 流式必需 | `--verbose` |
| 打字机效果 | `--include-partial-messages` |
| 多轮上下文 | `--resume <session_id>` |
| 会话级权限快照 | `--permission-mode <mode>` |
| 工具授权询问 | `--permission-prompt-tool stdio`（隐藏参数） |
| 受限工具集 | `--tools` / `--allowedTools` / `--disallowedTools` |
| 员工级 MCP | `--mcp-config` + `--strict-mcp-config` |

---

## 7. 维护

- 升级 Claude Code 后，重跑 `claude --help` 与本文比对；新增/删除的参数优先看主帮助，再看各子命令。
- 隐藏参数可用“传空值看报错”的方法探测：报 `argument missing` 说明存在，报 `unknown option` 说明不存在。
- 本文只覆盖命令行参数，不包含环境变量（`ANTHROPIC_API_KEY`、`CLAUDE_CODE_*` 等）与 `settings.json` 字段，这两部分见《20 设置与 Agent 配置》。
