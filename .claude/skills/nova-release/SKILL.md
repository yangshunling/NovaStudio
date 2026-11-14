---
name: nova-release
description: NovaStudio 发版标准流程。把 dev 分支的改动合并到 master，升级版本号，按固定格式编写版本说明与 CHANGELOG，打包 Windows 安装包并发布到 GitHub Release，最后把说明写入 Release 页面。当用户提到「发版」「发布新版本」「打包发布」「发布 0.x」「release」「写版本说明」「合并到 master」「上传安装包」时使用，即使没有明确说「发版」也要触发。
---

# NovaStudio 发版

按本流程发版。核心目标是：**日常代码只进 `dev`，`master` 只承接发版合并**；Release 页面必须有说明，且格式与历史版本一致。

## 0. 先确认三件事

动手前先确认，缺少任何一项就先向用户说明：

1. 当前在 `dev` 分支，且 `git status` 干净（有未提交改动先提交到 `dev`）；
2. 目标版本号（`0.x` 阶段：新功能升 MINOR，纯修复升 PATCH）；
3. 本次版本的一句话主题，用于说明与提交信息。

发布是外部可见且不可撤销的动作。合并、推送、上传前，把**版本号 + 说明全文**给用户看一眼，确认后再执行；用户已经在同一条消息里明确要求「直接发」时可以不重复确认。

## 1. 升级版本号

`package.json` 的 `version` 是唯一版本源，不要在任何其它地方维护第二份。

```bash
npm version X.Y.Z --no-git-tag-version
```

## 2. 写版本说明（严格按此格式）

保存到 `release-notes/release-notes-X.Y.Z.md`（该目录纳入 git，不要放 `release/`，那里被 gitignore）。

```markdown
## v0.5.0 — 2026-11-20

> 本版本聚焦一句话主题。

### ✨ 新增功能

#### 功能名

- 短句。
- 短句。

#### 功能名

- 短句。

### 🐛 修复

- 短句。
- 短句。

### ⬆️ 升级说明

- 短句。
```

格式规则（与 v0.1.0–v0.4.0 的 Release 页面保持一致）：

- 标题固定 `## v<版本号> — YYYY-MM-DD`；
- 标题下用 `>` 一句话概述，不堆细节；
- 功能小节用 `####`，**每个小节 3–5 条，每条尽量一行、只讲用户能看到的行为**；
- 不写文件名、函数名、chunk、SQL、内部重构等实现细节；
- 「修复」每条只描述现象与结果，不复述根因；
- 「升级说明」2–3 条，写清安装方式、数据兼容与行为变化；
- 全中文，句末用「。」；没有的板块直接省略，不要留空标题。

字数参考：v0.4.0 的正文约 940 字符，v0.3.0 约 770。明显超过 1200 字符就说明写细了。

## 3. 更新 CHANGELOG.md

在文件顶部插入新版本小节，格式沿用现有条目：

```markdown
## vX.Y.Z — YYYY-MM-DD

### 新增功能

**功能名**

- 可以比 Release 说明更细，允许写行为边界与实现约束。

### 变更与优化

**内部主题**

- ...

### 修复

- ...

### 升级说明

- ...
```

CHANGELOG 是给开发者看的明细，Release 页面是给用户看的简述；两者内容对应但长度不同。

## 4. 提交并合并到 master

```bash
git add CHANGELOG.md package.json package-lock.json release-notes/release-notes-X.Y.Z.md
git commit -m "发布 X.Y.Z：<一句话主题>"
git push origin dev

git checkout master
git merge --no-ff dev -m "发布 X.Y.Z：<一句话主题>"
git push origin master dev
```

必须用 `--no-ff` 保留版本边界，便于回滚与对比。发布动作只能在 `master` 上执行：GitHub Release 的标签跟的是 master HEAD，别把未合并的 `dev` 提交带进标签。

## 5. 打包发布

Windows 上 token 通常在用户环境变量里，当前 shell 可能还没继承：

```powershell
$env:GH_TOKEN=[Environment]::GetEnvironmentVariable('GH_TOKEN','User'); npm run package:win:publish
```

这条命令依次完成：`electron-vite build` → `electron-builder --win --publish always` → `node scripts/publish-release-notes.mjs`。

`GH_TOKEN` 没有时先让用户配置（fine-grained PAT，仓库选择 NovaStudio，Contents: Read and write）。也可以用 `git credential fill` 的 GCM token 兜底，但优先用环境变量。

## 6. 发布后核验

不要只看命令退出码。用 API 核对 Release 与说明：

```bash
curl -s https://api.github.com/repos/yangshunling/NovaStudio/releases/tags/vX.Y.Z \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log('draft:',r.draft,'bodyLen:',(r.body||'').length);console.log(r.assets.map(a=>a.name+' '+a.state).join('\n'))})"
```

同时确认：

- `release/latest.yml` 的 `version` 已是新版本；
- `git ls-remote --tags origin` 能看到 `vX.Y.Z`，且指向发布提交。

如果 Release 已上传但 `bodyLen` 为 0，补跑：

```bash
npm run release:notes
```

## 7. 收尾

```bash
git checkout dev
```

后续开发继续在 `dev` 上提交。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| Release 页面没有说明 | electron-builder 创建 Release 时只传 tag/name，不带 body | 运行 `npm run release:notes`；已默认串联在发布命令末尾 |
| 说明脚本报「还没有 vX.Y.Z 的 Release」 | 刚创建的 Release 短暂不可见，或打包进程异常退出 | 脚本已内置重试；仍失败就等几秒重跑 `npm run release:notes` |
| 说明脚本 404 | GitHub 没有按 tag PATCH 的接口 | 脚本已改为先取 release id 再 PATCH，不要改回按 tag 更新 |
| 重跑发布没有重新上传 | Release 已发布超过 2 小时会被跳过 | 先删除该 Release 再重发，或直接升 PATCH 版本 |
| 打包结尾出现 libuv 断言 | electron-builder 在 Node 24 退出时的清理问题 | 不影响产物与 Release；以第 6 步 API 核验为准 |
| 安装包启动黑屏 | markdown 依赖被拆成循环 chunk | 检查 `electron.vite.config.ts` 是否重新拆出 markdown chunk |
| `latest.yml` 没有 releaseNotes | 未配置 `releaseInfo` | 当前应用内不展示更新说明，可忽略 |
