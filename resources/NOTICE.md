# NOTICE — 第三方资源与开源软件许可声明

本文件随应用分发（`electron-builder` 的 `extraResources` 会把 `resources/` 整个复制到安装目录），
目的是让拿到安装包的最终用户能够看到 Nova 所使用的第三方资源及其授权条件。

**本文件不是法律意见。** 标注 `TODO` 的条目尚未补全，**对外分发前必须补齐**。

---

## 一、美术资源

### 1.1 女仆工坊皮肤素材

| 文件 | 用途 |
| --- | --- |
| `src/renderer/assets/maid/palace-day.webp` | 「女仆工坊 · 昼」皮肤的内容区背景 |
| `src/renderer/assets/maid/palace-night.webp` | 「女仆工坊 · 夜」皮肤的内容区背景 |
| `src/renderer/assets/maid/maid-left.webp` | 两套女仆皮肤的左下立绘 |
| `src/renderer/assets/maid/maid-right.webp` | 两套女仆皮肤的右下立绘 |

**授权协议：CC BY-NC-SA 4.0**
（Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International）
协议全文：<https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode>

该协议对本项目构成三项约束：

- **BY · 署名** —— 必须标注原作者、出处与协议名称。第 1.1.1 节用于满足此条。
- **NC · 非商业性使用** —— 不得用于商业目的；包含这些素材的发行物不得用于盈利。
  （注意：这条与署名是**两件独立的事**，即使署名完整，NC 仍然禁止商用。）
- **SA · 相同方式共享** —— 若对这些素材做了修改（见第 1.1.2 节），
  修改后的版本必须同样以 CC BY-NC-SA 4.0 协议发布。

#### 1.1.1 署名信息 — **TODO：待补充**

> ⚠️ 以下为原始素材出处，必须由素材来源方提供，**不得凭推测填写**。
> 署名信息填写错误，比缺失署名更糟。

- 原作者 / 团队：`TODO`
- 原作品名称：`TODO`
- 原作品链接：`TODO`
- 原始许可声明位置（原仓库的 LICENSE / README 路径）：`TODO`
- 现有线索（**待核实，未经确认不可作为署名依据**）：
  代码注释中残留的自述为 `dsh-deep-whale / maid-atelier`（DeepSeek Harness「深海女仆工坊」皮肤），
  该描述在重构前的注释中曾出现，但其是否等同于正式署名信息尚未确认。

#### 1.1.2 修改情况 — **TODO：待确认**

下列任一处理都属于协议中的「修改（Adapted Material）」，会触发 SA 条款：

- [ ] 格式转换（原始格式 → WebP）
- [ ] 尺寸缩放 / 裁剪
- [ ] 色彩、对比度或亮度调整
- [ ] 其它：`TODO`

若确有修改，需在此逐项说明，并确保修改后的素材同样以 CC BY-NC-SA 4.0 发布。

### 1.2 应用图标 — **TODO：待确认来源**

| 文件 | 用途 |
| --- | --- |
| `src/renderer/assets/logo.png` | 侧栏品牌图标 |
| `resources/logo.png` | 窗口 / 任务栏图标、安装包图标 |

- 来源：`TODO`
- 授权：`TODO`

若与第 1.1 节同源，请合并署名；若为自制，请在此声明；若来源不明，请在分发前替换或确认授权。

---

## 二、开源软件依赖

### 2.1 运行时依赖（会随安装包分发）

| 包 | 版本 | 许可证 |
| --- | --- | --- |
| better-sqlite3 | 11.10.0 | MIT |
| electron | 31.7.7 | MIT |
| execa | 9.6.1 | MIT |
| lucide-react | 0.428.0 | ISC |
| node-pty | 1.1.0 | MIT |
| react | 18.3.1 | MIT |
| react-dom | 18.3.1 | MIT |
| react-markdown | 9.1.0 | MIT |
| remark-gfm | 4.0.1 | MIT |
| shiki | 1.29.2 | MIT |
| zustand | 4.5.7 | MIT |

### 2.2 构建期依赖（不随包分发）

| 包 | 版本 | 许可证 |
| --- | --- | --- |
| @tailwindcss/vite | 4.3.3 | MIT |
| @vitejs/plugin-react | 4.7.0 | MIT |
| electron-builder | 24.13.3 | MIT |
| electron-vite | 2.3.0 | MIT |
| tailwindcss | 4.3.3 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vite | 5.4.21 | MIT |

> 上表的包名、版本、许可证均由各包自身的 `package.json` 读取而来，可逐一核对。
>
> 尽管构建期依赖不随包分发，Tailwind 生成的 CSS 会被打进产物；
> 如你的合规策略要求一并声明，保留本表即可。

### 2.3 间接依赖 — **TODO：待补全**

上述直接依赖还会引入大量间接依赖（本工程 `node_modules` 下共 463 个包）。
其中 `shiki` 会带入大量语法定义包、`react-markdown` 会带入 unified / remark 系列。

补全方式（任选其一，需联网）：

```bash
npx license-checker --production --json > licenses.json
# 或使用 license-report / license-webpack-plugin 等工具
```

- [ ] TODO：列出全部间接依赖及其许可证
- [ ] TODO：确认是否存在非 MIT / ISC / Apache-2.0 的强著佐权（copyleft）许可证
      —— 若存在 GPL / AGPL，会限制本项目的分发方式，需优先处理

### 2.4 许可证全文

- Electron 相关的许可证文件由 `electron-builder` 自动产出，位于安装目录：
  - `LICENSES.chromium.html`（Chromium 及其全部依赖）
  - `LICENSE.electron.txt`（Electron 本体）
- 其余各包的许可证全文位于其 `node_modules/<包名>/LICENSE*`。
- [ ] TODO：如需随包分发完整文本，在 `resources/` 下建立 `licenses/` 目录，
      将各包的 `LICENSE` 文件复制进去；本节列出对应文件名即可。

---

## 三、对外分发前检查清单

- [ ] 1.1.1 美术资源署名信息已补齐（原作者 / 原作品 / 链接 / 许可声明位置）
- [ ] 1.1.2 修改情况已逐项确认
- [ ] 1.2 应用图标来源与授权已确认
- [ ] 2.3 间接依赖清单已补全，且确认无 copyleft 冲突
- [ ] 2.4 许可证全文已随包分发
- [ ] 已确认本发行物符合美术素材的 **NC（非商业性）** 条款
- [ ] 若后续新增第三方素材（图片、字体、音效），同步更新本文件
