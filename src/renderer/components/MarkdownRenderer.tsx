/**
 * Markdown 渲染器
 *
 * 使用 react-markdown + remark-gfm + Shiki 渲染 Agent 返回的 Markdown 正文。
 * 支持流式：内容不完整时优雅降级（未闭合的代码块显示为纯文本，后续自动更新）。
 *
 * 代码高亮主题来自当前皮肤（SkinVariant.codeTheme），组件内不做任何主题推断；
 * 其余样式全部走语义类与 token，换肤自动适配。
 */

import { createContext, useContext, useEffect, useMemo, useState, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { getHighlighter, highlightCodeSync } from "../lib/shiki";
import { stripPreTag } from "../lib/utils";
import { useSkin } from "../hooks/useTheme";
import { ipc } from "../lib/ipc";

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
        className="my-2 inline-flex items-center rounded border border-border bg-surface px-2 py-1 text-caption text-text-muted"
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
      className="my-2 max-w-full rounded-md"
    />
  );
}

/** 代码块组件 — Shiki 高亮（主题取自当前皮肤） */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { codeTheme } = useSkin();
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    // 先尝试同步高亮（高亮器已就绪时）
    const sync = highlightCodeSync(code, lang, codeTheme);
    if (sync) {
      setHighlighted(stripPreTag(sync));
      return;
    }

    // 高亮器未就绪，异步初始化后重试
    let cancelled = false;
    getHighlighter().then(() => {
      if (cancelled) return;
      const result = highlightCodeSync(code, lang, codeTheme);
      if (result) setHighlighted(stripPreTag(result));
    });

    return () => {
      cancelled = true;
    };
  }, [code, lang, codeTheme]);

  if (highlighted) {
    return (
      <pre
        className="my-2 overflow-x-auto rounded-lg border border-border p-3 text-meta"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    );
  }

  // Fallback：高亮器未就绪时的纯文本显示
  return (
    <pre className="my-2 overflow-x-auto rounded-lg border border-border bg-surface p-3 text-meta text-text-secondary">
      <code>{code}</code>
    </pre>
  );
}

/** 内联代码 */
function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-surface-hover px-1.5 py-0.5 text-meta font-mono text-text">
      {children}
    </code>
  );
}

export interface MarkdownRendererProps {
  content: string;
  /** 项目文件预览时传入，用于解析 Markdown 中的本地相对路径图片 */
  projectId?: string;
  /** 当前 Markdown 文件相对项目根目录的路径 */
  markdownPath?: string;
  /** 是否渲染 raw HTML（README 等文档里的 <img> / <table>） */
  allowHtml?: boolean;
}

function MarkdownRendererImpl({
  content,
  projectId,
  markdownPath,
  allowHtml = false,
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

  return (
    <MarkdownImageContext.Provider value={imageContext}>
      <div className="nova-markdown text-body-lg leading-relaxed text-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={{
          // 代码块 vs 内联代码
          code({ className, children, ...props }) {
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
          h1: ({ children }) => <h1 className="ui-serif mb-3 mt-4 text-display font-bold text-text">{children}</h1>,
          h2: ({ children }) => <h2 className="ui-serif mb-2 mt-3 text-heading font-bold text-text">{children}</h2>,
          h3: ({ children }) => <h3 className="ui-serif mb-2 mt-3 text-body-lg font-bold text-text">{children}</h3>,

          p: ({ children }) => <p className="mb-2 leading-relaxed">{children}</p>,

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

          table: ({ children }) => (
            <table className="mb-2 border-collapse border border-border text-meta">
              {children}
            </table>
          ),
          th: ({ children }) => (
            <th className="border border-border bg-surface px-2 py-1 font-semibold text-text">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-1 text-text-secondary">
              {children}
            </td>
          ),

          hr: () => <hr className="my-3 border-border" />,

          pre: ({ children }) => <>{children}</>, // pre 由 CodeBlock 自己处理
        }}
      >
        {content}
      </ReactMarkdown>
      </div>
    </MarkdownImageContext.Provider>
  );
}

/** memo 化：相同内容不重新渲染（皮肤变化由 CodeBlock 内部订阅处理） */
export const MarkdownRenderer = memo(MarkdownRendererImpl);
