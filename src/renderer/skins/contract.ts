/**
 * 皮肤 token 契约 —— 唯一真相来源
 *
 * 这里是「一套皮肤需要提供哪些 token」的唯一清单：
 * - 运行时校验（validate.ts）直接读本文件，不再另抄一份
 * - styles/index.css 的映射表与本文件一一对应；新增 token 时两处同步
 * - skins/_base.css 与 skins/_families/*.css 提供的默认值也算「能解析」，
 *   因此校验的是最终**计算值**，而不是"这套皮肤自己写了哪些行"
 *
 * 分层与「谁提供值」的约定见 skins/_base.css 顶部说明。
 */

/**
 * 必须能解析出非空值的 token。
 *
 * 缺失会造成静默失效（透明背景、消失的边框、看不见的文字），
 * 所以在开发模式下逐套皮肤实检，一旦缺失立即在控制台报警。
 */
export const REQUIRED_TOKENS: readonly string[] = [
  // 背景
  "--c-bg",
  "--c-surface",
  "--c-surface-2",
  "--c-surface-hover",
  "--c-surface-active",
  // 玻璃
  "--c-glass-bg",
  "--c-glass-filter",
  "--c-glass-strong-bg",
  "--c-glass-strong-filter",
  // 边框
  "--c-border",
  "--c-border-strong",
  // 文本
  "--c-text",
  "--c-text-secondary",
  "--c-text-muted",
  // 强调
  "--c-accent",
  "--c-accent-hover",
  "--c-accent-foreground",
  "--c-accent-soft",
  // 语义
  "--c-thinking",
  "--c-thinking-bg",
  "--c-tool",
  "--c-error",
  "--c-error-bg",
  "--c-success",
  // Agent 标识色槽位（色值默认在 _base.css，皮肤可覆盖）
  "--c-agent-amber",
  "--c-agent-violet",
  "--c-agent-sky",
  "--c-agent-teal",
  "--c-agent-rose",
  "--c-agent-lime",
  // 气泡
  "--c-bubble-user",
  "--c-bubble-user-text",
  "--c-bubble-border",
  "--c-bubble-shadow",
  // 输入
  "--c-input-bg",
  "--c-input-border",
  "--c-input-border-focus",
  // 滚动条
  "--c-scrollbar",
  "--c-scrollbar-hover",
  // 阴影
  "--c-shadow",
  "--c-shadow-sm",
  // 字体
  "--c-font-size",
  "--c-font-sans",
  "--c-font-mono",
  "--c-font-serif",
  "--c-serif-tracking",
  // 圆角
  "--c-radius-sm",
  "--c-radius-md",
  "--c-radius-lg",
  "--c-radius-xl",
  "--c-radius-2xl",
  "--c-radius-bubble",
  "--c-radius-input",
  "--c-progress-radius",
  // 布局
  "--c-layout-sidebar",
  "--c-layout-drawer",
  "--c-layout-header",
  "--c-layout-content",
  "--c-layout-modal-w",
  "--c-layout-modal-h",
  "--c-layout-menu",
  // 间距（皮肤可变层）
  "--c-space-inset",
  "--c-space-card",
  "--c-space-section",
  "--c-space-field",
  // 控件尺寸
  "--c-size-avatar",
  "--c-size-icon-btn",
  // 动效
  "--c-motion-fast",
  "--c-motion-base",
  "--c-motion-slow",
  "--c-motion-loop",
  "--c-ease-standard",
  // 按钮
  "--c-btn-primary-bg",
  "--c-btn-primary-border",
  "--c-btn-primary-text",
  "--c-btn-primary-shadow",
  "--c-btn-ghost-border",
  "--c-btn-ghost-text",
  "--c-btn-ghost-hover-text",
  "--c-btn-ghost-hover-border",
  "--c-btn-ghost-hover-bg",
  "--c-btn-round-bg",
  "--c-btn-round-border",
  "--c-btn-round-text",
  "--c-btn-round-shadow",
  "--c-btn-round-hover-text",
  "--c-btn-round-hover-border",
  // 芯片
  "--c-ring-border",
  "--c-ring-shadow",
  // 选中条
  "--c-rail-bg",
  "--c-rail-glow",
  // 侧栏
  "--c-sidebar-bg",
  "--c-sidebar-shadow",
  "--c-sidebar-texture",
  // 进度条
  "--c-progress-height",
  "--c-progress-track",
  "--c-progress-fill",
  "--c-progress-glow",
];

/**
 * 可选 token：使用处都带 var() 第二参数兜底，未声明即表示该皮肤
 * 不需要对应的装饰或刻意采用默认值。
 */
export const OPTIONAL_TOKENS: readonly string[] = [
  // 内容页纸面：声明即为「画布 + 浮起的白纸」的层叠皮肤
  "--c-page-bg",
  "--c-page-shadow",
  "--c-page-inset",
  "--c-stage-veil",
  "--c-stage-figure-filter",
  "--c-stage-figure-inset",
  "--c-stage-figure-height",
  "--c-stage-figure-left-height",
  "--c-stage-figure-right-height",
];

/**
 * 派生 token：由 styles/index.css 从基准字号算出，皮肤不需要也不应该声明。
 *
 * 列在这里是为了让「CSS 里出现的每个 --c-* 都能被契约解释」这条守卫成立 ——
 * 防止将来有人在组件里临时加一个没人管的变量。
 */
export const DERIVED_TOKENS: readonly string[] = [
  "--c-chat-font-size",
  "--c-font-size-micro",
  "--c-font-size-caption",
  "--c-font-size-meta",
  "--c-font-size-body",
  "--c-font-size-body-lg",
  "--c-font-size-title",
  "--c-font-size-heading",
  "--c-font-size-display",
  "--c-font-size-hero",
];
