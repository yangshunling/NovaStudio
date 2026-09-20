/**
 * Markdown 渲染器
 *
 * 使用 react-markdown + remark-gfm + Shiki 渲染 Agent 返回的 Markdown 正文。
 * 支持流式：内容不完整时优雅降级（未闭合的代码块显示为纯文本，后续自动更新）。
 *
 * 代码高亮主题来自当前皮肤（SkinVariant.codeTheme），组件内不做任何主题推断；
 * 其余样式全部走语义类与 token，换肤自动适配。
 */

import { useEffect, useState, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getHighlighter, highlightCodeSync } from "../lib/shiki";
import { useSkin } from "../hooks/useTheme";

/** Shiki 输出的 HTML 需要去掉外层 <pre>，由我们自己控制容器样式 */
function stripPreTag(html: string): string {
  return html.replace(/^<pre[^>]*>/, "").replace(/<\/pre>$/, "");
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

function MarkdownRendererImpl({ content }: { content: string }) {
  return (
    <div className="nova-markdown text-body-lg leading-relaxed text-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
  );
}

/** memo 化：相同内容不重新渲染（皮肤变化由 CodeBlock 内部订阅处理） */
export const MarkdownRenderer = memo(MarkdownRendererImpl);
