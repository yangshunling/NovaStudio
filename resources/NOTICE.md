# NOTICE

**Nova Studio 0.2.0**

本文件列出 Nova Studio 随安装包分发的第三方软件与资源，以及各自的许可条款。
打包时 `resources/` 会被整体复制到安装目录，最终用户可在
`<安装目录>/resources/NOTICE.md` 查看本文件。

清单中的版本取自 `package-lock.json` 的实际安装结果；仅列随应用分发的运行时依赖，
构建期工具单独标注。若需核对或重新生成，见文末「维护」。

---

## 一、第三方软件

### 1.1 直接依赖（随应用运行时分发）

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| [@assistant-ui/react](https://github.com/assistant-ui/assistant-ui) | 0.15.26 | MIT |
| [@xterm/addon-fit](https://github.com/xtermjs/xterm.js) | 0.11.0 | MIT |
| [@xterm/xterm](https://github.com/xtermjs/xterm.js) | 6.0.0 | MIT |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 11.10.0 | MIT |
| [electron-updater](https://github.com/electron-userland/electron-builder) | 6.8.11 | MIT |
| [lucide-react](https://github.com/lucide-icons/lucide) | 0.428.0 | ISC |
| [node-pty](https://github.com/microsoft/node-pty) | 1.1.0 | MIT |
| [react](https://github.com/facebook/react) | 18.3.1 | MIT |
| [react-dom](https://github.com/facebook/react) | 18.3.1 | MIT |
| [react-markdown](https://github.com/remarkjs/react-markdown) | 9.1.0 | MIT |
| [rehype-raw](https://github.com/rehypejs/rehype-raw) | 7.0.0 | MIT |
| [rehype-sanitize](https://github.com/rehypejs/rehype-sanitize) | 6.0.0 | MIT |
| [remark-gfm](https://github.com/remarkjs/remark-gfm) | 4.0.1 | MIT |
| [shiki](https://github.com/shikijs/shiki) | 1.29.2 | MIT |
| [zustand](https://github.com/pmndrs/zustand) | 4.5.7 | MIT |

### 1.2 间接依赖

运行时依赖树共 288 个包（含上表 15 个直接依赖），全部为宽松许可证，
未包含 GPL / AGPL / LGPL 等 copyleft 组件。

| 许可证 | 数量 |
| --- | --- |
| MIT | 268 |
| ISC | 10 |
| Apache-2.0 | 2 |
| BSD-3-Clause | 2 |
| BSD-2-Clause | 1 |
| 0BSD | 1 |
| Python-2.0 | 1 |
| BlueOak-1.0.0 | 1 |
| MIT OR WTFPL | 1 |
| BSD-2-Clause OR MIT OR Apache-2.0 | 1 |

完整清单按许可证分组如下：

<details>
<summary>MIT（268）</summary>

- `@assistant-ui/core@0.3.25`
- `@assistant-ui/react@0.15.26`
- `@assistant-ui/store@0.3.18`
- `@assistant-ui/tap@0.9.22`
- `@babel/runtime@7.29.10`
- `@floating-ui/core@1.8.0`
- `@floating-ui/dom@1.8.0`
- `@floating-ui/react-dom@2.1.9`
- `@floating-ui/utils@0.2.12`
- `@radix-ui/number@1.1.3`
- `@radix-ui/primitive@1.1.7`
- `@radix-ui/react-accessible-icon@1.1.16`
- `@radix-ui/react-accordion@1.2.21`
- `@radix-ui/react-alert-dialog@1.1.24`
- `@radix-ui/react-arrow@1.1.16`
- `@radix-ui/react-aspect-ratio@1.1.16`
- `@radix-ui/react-avatar@1.2.7`
- `@radix-ui/react-checkbox@1.3.12`
- `@radix-ui/react-collapsible@1.1.21`
- `@radix-ui/react-collection@1.1.16`
- `@radix-ui/react-compose-refs@1.1.5`
- `@radix-ui/react-context@1.2.2`
- `@radix-ui/react-context-menu@2.3.8`
- `@radix-ui/react-dialog@1.2.0`
- `@radix-ui/react-direction@1.1.5`
- `@radix-ui/react-dismissable-layer@1.1.20`
- `@radix-ui/react-dropdown-menu@2.1.25`
- `@radix-ui/react-focus-guards@1.1.6`
- `@radix-ui/react-focus-scope@1.2.0`
- `@radix-ui/react-form@0.2.0`
- `@radix-ui/react-hover-card@1.1.24`
- `@radix-ui/react-id@1.1.4`
- `@radix-ui/react-label@2.1.16`
- `@radix-ui/react-menu@2.1.25`
- `@radix-ui/react-menubar@1.1.25`
- `@radix-ui/react-navigation-menu@1.3.0`
- `@radix-ui/react-one-time-password-field@0.1.17`
- `@radix-ui/react-password-toggle-field@0.1.12`
- `@radix-ui/react-popover@1.2.0`
- `@radix-ui/react-popper@1.3.8`
- `@radix-ui/react-portal@1.1.18`
- `@radix-ui/react-presence@1.1.11`
- `@radix-ui/react-primitive@2.1.11`
- `@radix-ui/react-progress@1.1.17`
- `@radix-ui/react-radio-group@1.4.8`
- `@radix-ui/react-roving-focus@1.1.20`
- `@radix-ui/react-scroll-area@1.3.0`
- `@radix-ui/react-select@2.3.8`
- `@radix-ui/react-separator@1.1.16`
- `@radix-ui/react-slider@1.5.0`
- `@radix-ui/react-slot@1.4.0`
- `@radix-ui/react-switch@1.3.8`
- `@radix-ui/react-tabs@1.1.22`
- `@radix-ui/react-toast@1.2.24`
- `@radix-ui/react-toggle@1.1.19`
- `@radix-ui/react-toggle-group@1.1.20`
- `@radix-ui/react-toolbar@1.1.20`
- `@radix-ui/react-tooltip@1.3.0`
- `@radix-ui/react-use-callback-ref@1.1.4`
- `@radix-ui/react-use-controllable-state@1.2.6`
- `@radix-ui/react-use-effect-event@0.0.5`
- `@radix-ui/react-use-escape-keydown@1.1.5`
- `@radix-ui/react-use-is-hydrated@0.1.3`
- `@radix-ui/react-use-layout-effect@1.1.4`
- `@radix-ui/react-use-previous@1.1.4`
- `@radix-ui/react-use-rect@1.1.4`
- `@radix-ui/react-use-size@1.1.5`
- `@radix-ui/react-visually-hidden@1.2.12`
- `@radix-ui/rect@1.1.3`
- `@shikijs/core@1.29.2`
- `@shikijs/engine-javascript@1.29.2`
- `@shikijs/engine-oniguruma@1.29.2`
- `@shikijs/langs@1.29.2`
- `@shikijs/themes@1.29.2`
- `@shikijs/types@1.29.2`
- `@shikijs/vscode-textmate@10.0.2`
- `@standard-schema/spec@1.1.0`
- `@types/debug@4.1.13`
- `@types/estree@1.0.9`
- `@types/estree-jsx@1.0.5`
- `@types/hast@3.0.5`
- `@types/json-schema@7.0.15`
- `@types/mdast@4.0.4`
- `@types/ms@2.1.0`
- `@types/prop-types@15.7.15`
- `@types/react@18.3.31`
- `@types/react-dom@18.3.7`
- `@types/unist@3.0.3`
- `@types/unist@2.0.11`
- `@xterm/addon-fit@0.11.0`
- `@xterm/xterm@6.0.0`
- `aria-hidden@1.2.6`
- `assistant-cloud@0.2.6`
- `assistant-stream@0.3.49`
- `bail@2.0.2`
- `base64-js@1.5.1`
- `better-sqlite3@11.10.0`
- `bindings@1.5.0`
- `bl@4.1.0`
- `buffer@5.7.1`
- `builder-util-runtime@9.7.0`
- `ccount@2.0.1`
- `character-entities@2.0.2`
- `character-entities-html4@2.1.0`
- `character-entities-legacy@3.0.0`
- `character-reference-invalid@2.0.1`
- `comma-separated-tokens@2.0.3`
- `csstype@3.2.3`
- `debug@4.4.3`
- `decode-named-character-reference@1.3.0`
- `decompress-response@6.0.0`
- `deep-extend@0.6.0`
- `dequal@2.0.3`
- `detect-node-es@1.1.0`
- `devlop@1.1.0`
- `electron-updater@6.8.11`
- `emoji-regex-xs@1.0.0`
- `end-of-stream@1.4.5`
- `escape-string-regexp@5.0.0`
- `estree-util-is-identifier-name@3.0.0`
- `extend@3.0.2`
- `file-uri-to-path@1.0.0`
- `fs-constants@1.0.0`
- `fs-extra@10.1.0`
- `get-nonce@1.0.1`
- `github-from-package@0.0.0`
- `hast-util-from-parse5@8.0.4`
- `hast-util-parse-selector@4.0.0`
- `hast-util-raw@9.1.0`
- `hast-util-sanitize@5.0.2`
- `hast-util-to-html@9.0.5`
- `hast-util-to-jsx-runtime@2.3.6`
- `hast-util-to-parse5@8.0.1`
- `hast-util-whitespace@3.0.0`
- `hastscript@9.0.3`
- `html-url-attributes@3.0.1`
- `html-void-elements@3.0.0`
- `inline-style-parser@0.2.7`
- `is-alphabetical@2.0.1`
- `is-alphanumerical@2.0.1`
- `is-decimal@2.0.1`
- `is-hexadecimal@2.0.1`
- `is-plain-obj@4.1.0`
- `js-tokens@4.0.0`
- `js-yaml@4.3.2`
- `jsonfile@6.2.1`
- `lazy-val@1.0.5`
- `lodash.escaperegexp@4.1.2`
- `lodash.isequal@4.5.0`
- `longest-streak@3.1.0`
- `loose-envify@1.4.0`
- `markdown-table@3.0.4`
- `mdast-util-find-and-replace@3.0.2`
- `mdast-util-from-markdown@2.0.3`
- `mdast-util-gfm@3.1.0`
- `mdast-util-gfm-autolink-literal@2.0.1`
- `mdast-util-gfm-footnote@2.1.0`
- `mdast-util-gfm-strikethrough@2.0.0`
- `mdast-util-gfm-table@2.0.0`
- `mdast-util-gfm-task-list-item@2.0.0`
- `mdast-util-mdx-expression@2.0.1`
- `mdast-util-mdx-jsx@3.2.0`
- `mdast-util-mdxjs-esm@2.0.1`
- `mdast-util-phrasing@4.1.0`
- `mdast-util-to-hast@13.2.1`
- `mdast-util-to-markdown@2.1.2`
- `mdast-util-to-string@4.0.0`
- `micromark@4.0.2`
- `micromark-core-commonmark@2.0.3`
- `micromark-extension-gfm@3.0.0`
- `micromark-extension-gfm-autolink-literal@2.1.0`
- `micromark-extension-gfm-footnote@2.1.0`
- `micromark-extension-gfm-strikethrough@2.1.0`
- `micromark-extension-gfm-table@2.1.2`
- `micromark-extension-gfm-tagfilter@2.0.0`
- `micromark-extension-gfm-task-list-item@2.1.0`
- `micromark-factory-destination@2.0.1`
- `micromark-factory-label@2.0.1`
- `micromark-factory-space@2.0.1`
- `micromark-factory-title@2.0.1`
- `micromark-factory-whitespace@2.0.1`
- `micromark-util-character@2.1.1`
- `micromark-util-chunked@2.0.1`
- `micromark-util-classify-character@2.0.1`
- `micromark-util-combine-extensions@2.0.1`
- `micromark-util-decode-numeric-character-reference@2.0.2`
- `micromark-util-decode-string@2.0.1`
- `micromark-util-encode@2.0.1`
- `micromark-util-html-tag-name@2.0.1`
- `micromark-util-normalize-identifier@2.0.1`
- `micromark-util-resolve-all@2.0.1`
- `micromark-util-sanitize-uri@2.0.1`
- `micromark-util-subtokenize@2.1.0`
- `micromark-util-symbol@2.0.1`
- `micromark-util-types@2.0.2`
- `mimic-response@3.1.0`
- `minimist@1.2.8`
- `mkdirp-classic@0.5.3`
- `ms@2.1.3`
- `nanoid@6.0.2`
- `nanoid@6.0.2`
- `napi-build-utils@2.0.0`
- `node-abi@3.96.0`
- `node-addon-api@7.1.1`
- `node-pty@1.1.0`
- `oniguruma-to-es@2.3.0`
- `parse-entities@4.0.2`
- `parse5@7.3.0`
- `prebuild-install@7.1.3`
- `property-information@7.2.0`
- `pump@3.0.4`
- `radix-ui@1.7.0`
- `react@18.3.1`
- `react-dom@18.3.1`
- `react-markdown@9.1.0`
- `react-remove-scroll@2.7.2`
- `react-remove-scroll-bar@2.3.8`
- `react-style-singleton@2.2.3`
- `react-textarea-autosize@8.5.9`
- `readable-stream@3.6.2`
- `regex@5.1.1`
- `regex-recursion@5.1.1`
- `regex-utilities@2.3.0`
- `rehype-raw@7.0.0`
- `rehype-sanitize@6.0.0`
- `remark-gfm@4.0.1`
- `remark-parse@11.0.0`
- `remark-rehype@11.1.2`
- `remark-stringify@11.0.0`
- `safe-buffer@5.2.1`
- `safe-content-frame@0.0.33`
- `scheduler@0.23.2`
- `shiki@1.29.2`
- `simple-concat@1.0.1`
- `simple-get@4.0.1`
- `space-separated-tokens@2.0.2`
- `string_decoder@1.3.0`
- `stringify-entities@4.0.4`
- `strip-json-comments@2.0.1`
- `style-to-js@1.1.21`
- `style-to-object@1.0.14`
- `tar-fs@2.1.5`
- `tar-stream@2.2.0`
- `tiny-typed-emitter@2.1.0`
- `trim-lines@3.0.1`
- `trough@2.2.0`
- `unified@11.0.5`
- `unist-util-is@6.0.1`
- `unist-util-position@5.0.0`
- `unist-util-stringify-position@4.0.0`
- `unist-util-visit@5.1.0`
- `unist-util-visit-parents@6.0.2`
- `universalify@2.0.1`
- `use-callback-ref@1.3.3`
- `use-composed-ref@1.4.0`
- `use-isomorphic-layout-effect@1.2.1`
- `use-latest@1.3.0`
- `use-sidecar@1.1.3`
- `use-sync-external-store@1.7.0`
- `util-deprecate@1.0.2`
- `vfile@6.0.3`
- `vfile-location@5.0.3`
- `vfile-message@4.0.3`
- `web-namespaces@2.0.1`
- `zod@4.6.5`
- `zustand@5.0.15`
- `zustand@4.5.7`
- `zwitch@2.0.4`

</details>

<details>
<summary>ISC（10）</summary>

- `@ungap/structured-clone@1.4.0`
- `chownr@1.1.4`
- `graceful-fs@4.2.11`
- `inherits@2.0.4`
- `ini@1.3.8`
- `lucide-react@0.428.0`
- `once@1.4.0`
- `semver@7.7.4`
- `semver@7.8.5`
- `wrappy@1.0.2`

</details>

<details>
<summary>Apache-2.0（2）</summary>

- `detect-libc@2.1.2`
- `tunnel-agent@0.6.0`

</details>

<details>
<summary>BSD-3-Clause（2）</summary>

- `ieee754@1.2.1`
- `secure-json-parse@4.1.0`

</details>

<details>
<summary>Python-2.0（1）</summary>

- `argparse@2.0.1`

</details>

<details>
<summary>BSD-2-Clause（1）</summary>

- `entities@6.0.1`

</details>

<details>
<summary>(MIT OR WTFPL)（1）</summary>

- `expand-template@2.0.3`

</details>

<details>
<summary>(BSD-2-Clause OR MIT OR Apache-2.0)（1）</summary>

- `rc@1.2.8`

</details>

<details>
<summary>BlueOak-1.0.0（1）</summary>

- `sax@1.6.1`

</details>

<details>
<summary>0BSD（1）</summary>

- `tslib@2.8.1`

</details>

### 1.3 非 MIT / ISC 许可证

以下组件的许可证条款与 MIT / ISC 不同，使用时请保留其版权与许可声明：

| 许可证 | 组件 | 说明 |
| --- | --- | --- |
| Apache-2.0 | `detect-libc@2.1.2`、`tunnel-agent@0.6.0` | 保留版权、许可声明与变更说明 |
| Python-2.0 | `argparse@2.0.1` | Python Software Foundation License |
| BSD-3-Clause | `ieee754@1.2.1`、`secure-json-parse@4.1.0` | 不得以作者名义背书 |
| BSD-2-Clause | `entities@6.0.1` | 保留版权与免责声明 |
| BlueOak-1.0.0 | `sax@1.6.1` | 宽松许可，允许商业使用 |
| 0BSD | `tslib@2.8.1` | 无署名要求 |
| MIT OR WTFPL | `expand-template@2.0.3` | 本项目按 MIT 条款使用 |
| BSD-2-Clause OR MIT OR Apache-2.0 | `rc@1.2.8` | 本项目按 MIT 条款使用 |

### 1.4 构建期依赖（不随安装包分发）

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| @iconify-json/vscode-icons | 1.2.87 | MIT |
| @tailwindcss/vite | 4.3.3 | MIT |
| @vitejs/plugin-react | 4.7.0 | MIT |
| electron-builder | 24.13.3 | MIT |
| electron-vite | 2.3.0 | MIT |
| tailwindcss | 4.3.3 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vite | 5.4.21 | MIT |

构建期工具本身不进入安装包，但 Tailwind 生成的样式表会打包进产物，
其内容仍受 MIT 条款约束。

### 1.5 Electron 与 Chromium

应用基于 Electron 31.7.7（MIT）运行。Electron 及其内置的 Chromium 依赖的许可文件
由 `electron-builder` 在打包时自动附带，位于安装目录：

- `LICENSE.electron.txt` — Electron 本体
- `LICENSES.chromium.html` — Chromium 及其全部依赖

---

## 二、美术与品牌资源

| 资源 | 用途 |
| --- | --- |
| `resources/logo.png` | 窗口 / 任务栏图标、安装包图标 |
| `src/renderer/assets/logo.png` | 侧栏品牌图标 |
| `resources/preview/*.png` | 文档与产品页截图 |

以上为本项目自制资源，随 Nova Studio 以 MIT 许可发布。

---

## 三、许可证全文

- 各 npm 包的完整许可证文本随包分发，位于应用内
  `node_modules/<包名>/LICENSE*`；
- Electron 与 Chromium 的许可证文本见 1.5 节所列文件；
- 若需要单文件汇总清单，可在本仓库根目录运行：

```bash
npx license-checker --production --json > licenses.json
```

---

## 四、维护

本文件依据 `package-lock.json` 生成，对应 `package.json` 中的版本 `0.2.0`。

新增或升级依赖后：

1. `npm install` 更新 `package-lock.json`；
2. 重新生成本文的依赖清单（1.1 / 1.2 / 1.3 / 1.4 节）；
3. 如引入新的美术资源或许可类型，同步补充第二、三节。

`1.2` 节的完整清单由脚本从 lockfile 生成，请勿手工编辑。
