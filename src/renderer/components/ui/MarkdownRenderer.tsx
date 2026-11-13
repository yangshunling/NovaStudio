/**
 * Markdown 渲染器
 *
 * 使用 react-markdown + remark-gfm + Shiki 渲染 Agent 返回的 Markdown 正文。
 * 支持流式：内容不完整时优雅降级（未闭合的代码块显示为纯文本，后续自动更新）。
 *
 * 代码高亮主题来自当前皮肤（SkinVariant.codeTheme），组件内不做任何主题推断；
 * 其余样式全部走语义类与 token，换肤自动适配。
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  memo,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Check, Copy } from "lucide-react";
import { stripPreTag } from "../../lib/utils";
import { copyText } from "../../lib/clipboard";
import { toast } from "../../stores/toast";
import { useSkin } from "../../hooks/useTheme";
import { ipc } from "../../lib/ipc";
import {
  MARKDOWN_BLOCK_THRESHOLD,
  splitMarkdownBlocks,
} from "../../lib/markdown-blocks";

/**
 * 内嵌图片的解析上下文。
 *
 * Markdown 里的相对路径图片由主进程按「文档所在目录」读取并转成 data URL：
 * 渲染进程本身无法访问本地文件（页面基址是 dev server / 应用目录）。
 */
interface MarkdownImageContextValue {
  projectId: string;
  markdownPath: string;
}

const MarkdownImageContext = createContext<MarkdownImageContextValue | null>(null);

/**
 * 是否处于流式输出中。
 *
 * 流式期间代码块内容还在增长，Shiki 的同步 tokenize 会在每个增量上阻塞主线程；
 * 此时先按纯文本渲染，等消息结束后再高亮一次（视觉上相同，开销从 O(n²) 降到 O(n)）。
 */
const MarkdownStreamingContext = createContext(false);

/** 允许 raw HTML 时使用的清洗规则：保留 README 常用的表格 / 图片属性 */
const htmlSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-./]],
    table: [...(defaultSchema.attributes?.table ?? []), "width", "align", "border"],
    img: [...(defaultSchema.attributes?.img ?? []), "alt", "width", "height"],
  },
};

/** 远程 / data URL 由浏览器直接加载，只有项目内的相对路径需要走 IPC */
const EXTERNAL_SRC = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function MarkdownImage({
  src,
  alt,
  node: _node,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
  const context = useContext(MarkdownImageContext);
  const external = !src || EXTERNAL_SRC.test(src);
  const [resolved, setResolved] = useState<string | null>(external ? src ?? null : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!src || external) {
      setResolved(src ?? null);
      setFailed(false);
      return;
    }

    // 没有工程上下文（如对话消息）时退回原始路径，交给浏览器尝试
    if (!context) {
      setResolved(src);
      setFailed(false);
      return;
    }

    let cancelled = false;
    setResolved(null);
    setFailed(false);
    ipc
      .readEmbeddedImage(context.projectId, context.markdownPath, src)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setResolved(result.dataUrl);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [src, external, context?.projectId, context?.markdownPath, context]);

  if (failed) {
    return (
      <span
        title={src}
        className="ui-type-sub my-2 inline-flex items-center rounded-sm border border-border bg-surface px-2 py-1 text-text-muted"
      >
        图片无法加载：{alt || src}
      </span>
    );
  }

  if (!resolved) return null;

  return (
    <img
      src={resolved}
      alt={alt}
      {...props}
      loading="lazy"
      decoding="async"
      // 外部图片不带 Referer，降低本地优先场景下的追踪面
      referrerPolicy="no-referrer"
      className="my-2 max-w-full rounded-md"
    />
  );
}

/** 代码块组件 — Shiki 高亮（主题取自当前皮肤） */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { codeTheme } = useSkin();
  const streaming = useContext(MarkdownStreamingContext);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  /*
   * 复制按钮的成功态由本地状态持有：代码块在流式期间会被反复渲染，
   * 但复制反馈只需要持续一瞬，交给 setTimeout 复位即可。
   */
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copy = () => {
    void copyText(code).then((ok) => {
      if (!ok) {
        toast.error("复制失败，请手动选择代码");
        return;
      }
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
    });
  };

  useEffect(() => {
    // 流式期间代码还没定型：跳过 Shiki，先显示纯文本
    if (streaming) {
      setHighlighted(null);
      return;
    }

    let cancelled = false;

    /*
     * Shiki 的语言包 + 主题约 2.7MB，绝不能因为「可能有一段代码」就进入
     * 首屏主包。这里改为首次出现代码块时动态加载；加载完成前先显示
     * 纯文本，视觉上只差一次高亮着色。
     */
    void import("../../lib/shiki")
      .then(async (shiki) => {
        if (cancelled) return;
        const sync = shiki.highlightCodeSync(code, lang, codeTheme);
        if (sync) {
          setHighlighted(stripPreTag(sync));
          return;
        }
        await shiki.getHighlighter();
        if (cancelled) return;
        const result = shiki.highlightCodeSync(code, lang, codeTheme);
        if (result) setHighlighted(stripPreTag(result));
      })
      .catch(() => {
        // 加载失败保持纯文本
      });

    return () => {
      cancelled = true;
    };
  }, [code, lang, codeTheme, streaming]);

  /*
   * 复制按钮必须挂在 pre 之外：pre 内部是 Shiki 生成的 span 树，
   * 放进去会被高亮结果覆盖；同时用 group/code 让按钮只在悬停时出现，
   * 不遮挡代码阅读。
   */
  return (
    <div className="group/code relative">
      {highlighted ? (
        <pre
          className="ui-type-code my-2 overflow-x-auto rounded-lg border border-border p-3"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        // Fallback：高亮器未就绪时的纯文本显示
        <pre className="ui-type-code my-2 overflow-x-auto rounded-lg border border-border bg-surface p-3 text-text-secondary">
          <code>{code}</code>
        </pre>
      )}
      <button
        type="button"
        onClick={copy}
        title={copied ? "已复制" : "复制代码"}
        aria-label={copied ? "已复制" : "复制代码"}
        className="absolute right-2 top-2 rounded-md border border-border/70 bg-surface/90 p-1.5 text-text-muted opacity-0 shadow-[var(--c-shadow-sm)] backdrop-blur-sm transition-[opacity,color] hover:text-text focus-visible:opacity-100 group-hover/code:opacity-100"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

/**
 * 读取 raw HTML 上的 align 属性。
 *
 * README 常用 `<p align="center">` / `<td align="center">` 做居中与并排排版。
 * 自定义组件默认只接收 children，会把 align 丢掉，导致居中内容在预览里全部左对齐。
 */
function alignClass(node?: { properties?: Record<string, unknown> }): string {
  const value = node?.properties?.align;
  if (value === "center") return " text-center";
  if (value === "right") return " text-right";
  return "";
}

/** `<table width="100%">` 在预览里同样会丢宽度，这里补成 w-full */
function tableWidthClass(node?: { properties?: Record<string, unknown> }): string {
  const width = node?.properties?.width;
  return width === "100%" || width === 100 ? " w-full" : "";
}

/** 内联代码 */
function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="ui-type-code rounded-sm bg-surface-hover px-1.5 py-0.5 text-text">
      {children}
    </code>
  );
}

/**
 * Markdown 元素渲染表。
 *
 * 必须放在模块作用域：react-markdown 会把这里的函数**直接当作 React 元素类型**
 * 使用，函数引用一变，React 就认为组件类型变了，会卸载并重建整棵子树。
 * 内联写法会让流式期间每次刷新都把整段已渲染的 Markdown DOM 摧毁重建，
 * 代价远高于正常的差分更新（还会丢失文本选中和代码块的内部状态）。
 *
 * 这些渲染器都不依赖 props / state，可以安全地长期复用同一引用。
 */
const MARKDOWN_COMPONENTS: Components = {
  // 代码块 vs 内联代码
  code({ className, children }) {
    const match = /language-(\w+)/.exec(className || "");
    const isBlock = !!match || String(children).includes("\n");

    if (isBlock) {
      const lang = match?.[1] ?? "text";
      const code = String(children).replace(/\n$/, "");
      return <CodeBlock code={code} lang={lang} />;
    }

    return <InlineCode>{children}</InlineCode>;
  },

  // 自定义元素样式
  h1: ({ children, node }) => (
    <h1 className={`ui-type-display mb-3 mt-4 text-text${alignClass(node)}`}>{children}</h1>
  ),
  h2: ({ children, node }) => (
    <h2 className={`ui-type-heading mb-2 mt-3 text-text${alignClass(node)}`}>{children}</h2>
  ),
  h3: ({ children, node }) => (
    <h3 className={`mb-2 mt-3 text-body-lg font-bold text-text${alignClass(node)}`}>{children}</h3>
  ),

  p: ({ children, node }) => (
    <p className={`mb-2 leading-relaxed${alignClass(node)}`}>{children}</p>
  ),

  ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => <li className="text-text">{children}</li>,

  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
      {children}
    </a>
  ),

  img: MarkdownImage,

  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-border-strong pl-3 text-text-secondary italic">
      {children}
    </blockquote>
  ),

  table: ({ children, node }) => (
    <table className={`ui-type-note mb-2 border-collapse border border-border${tableWidthClass(node)}`}>
      {children}
    </table>
  ),
  th: ({ children, node }) => (
    <th className={`border border-border bg-surface px-2 py-1 font-semibold text-text${alignClass(node)}`}>
      {children}
    </th>
  ),
  td: ({ children, node }) => (
    <td className={`border border-border px-2 py-1 text-text-secondary${alignClass(node)}`}>
      {children}
    </td>
  ),

  hr: () => <hr className="my-3 border-border" />,

  pre: ({ children }) => <>{children}</>, // pre 由 CodeBlock 自己处理
};

/** remark 插件表：同样保持引用稳定 */
const REMARK_PLUGINS = [remarkGfm];

export interface MarkdownRendererProps {
  content: string;
  /** 项目文件预览时传入，用于解析 Markdown 中的本地相对路径图片 */
  projectId?: string;
  /** 当前 Markdown 文件相对项目根目录的路径 */
  markdownPath?: string;
  /** 是否渲染 raw HTML（README 等文档里的 <img> / <table>） */
  allowHtml?: boolean;
  /** 内容仍在流式增长：跳过昂贵的代码高亮，等定型后再执行 */
  streaming?: boolean;
  /**
   * 不输出外层 .nova-markdown 容器。
   * 块级渲染时由父组件提供唯一容器，否则每个块都会命中
   * `.nova-markdown > :last-child { margin-bottom: 0 }`，块间距被吃掉。
   */
  bare?: boolean;
}

function MarkdownRendererImpl({
  content,
  projectId,
  markdownPath,
  allowHtml = false,
  streaming = false,
  bare = false,
}: MarkdownRendererProps) {
  const imageContext = useMemo(
    () =>
      projectId && markdownPath ? { projectId, markdownPath } : null,
    [projectId, markdownPath],
  );

  const rehypePlugins = useMemo(
    () =>
      allowHtml
        ? ([rehypeRaw, [rehypeSanitize, htmlSchema]] as Parameters<
            typeof ReactMarkdown
          >[0]["rehypePlugins"])
        : undefined,
    [allowHtml],
  );

  const markdown = (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={rehypePlugins}
      components={MARKDOWN_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );

  return (
    <MarkdownImageContext.Provider value={imageContext}>
      <MarkdownStreamingContext.Provider value={streaming}>
        {bare ? (
          markdown
        ) : (
          <div className="nova-markdown ui-type-prose text-text">{markdown}</div>
        )}
      </MarkdownStreamingContext.Provider>
    </MarkdownImageContext.Provider>
  );
}

/** memo 化：相同内容不重新渲染（皮肤变化由 CodeBlock 内部订阅处理） */
export const MarkdownRenderer = memo(MarkdownRendererImpl);

/**
 * 流式 Markdown 渲染器。
 *
 * 长正文按「已写完的块 + 正在增长的尾巴」渲染：块一旦写完就不再参与
 * 后续刷新，每帧只重解析尾巴。阈值以下的短文本仍走整段渲染（少一层
 * 组件开销）。切分规则与为什么不能更激进见 lib/markdown-blocks.ts。
 */
function StreamingMarkdownImpl({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  /*
   * 长正文始终按块渲染（不只流式期间）：回复结束时若切回整段渲染，
   * 整棵 React 树会被卸载重建，反而在「刚好写完」的瞬间卡一下。
   * 保持同一种树形，结束时只有尾块需要再渲染一次（补上代码高亮）。
   */
  const blocks = useMemo(
    () =>
      content.length >= MARKDOWN_BLOCK_THRESHOLD
        ? splitMarkdownBlocks(content)
        : null,
    [content],
  );

  if (!blocks || blocks.stable.length === 0) {
    return <MarkdownRenderer content={content} streaming={streaming} />;
  }

  return (
    /*
     * 唯一的 .nova-markdown 容器：块间距、首尾边距归零都按「整段」计算，
     * 与未切分时一致；每个块自身不再套容器（bare）。
     */
    <div className="nova-markdown ui-type-prose text-text">
      {blocks.stable.map((block, index) => (
        // 块只追加不修改，index 作为 key 在整轮流式中保持稳定
        <MarkdownRenderer key={index} content={block} bare />
      ))}
      {blocks.tail && (
        <MarkdownRenderer content={blocks.tail} streaming bare />
      )}
    </div>
  );
}

export const StreamingMarkdown = memo(StreamingMarkdownImpl);
