/**
 * 项目文件只读预览
 *
 * 文本 / 代码使用 Shiki，Markdown 可切换预览与源码，
 * 图片与 PDF 使用主进程返回的 data URL，其他类型回退到系统默认程序。
 */

import { useEffect, useState } from "react";
import {
  AlertCircle,
  ExternalLink,
  Eye,
  FileCode2,
  Loader2,
  RotateCw,
} from "lucide-react";
import type {
  FilePreview as FilePreviewData,
} from "@shared/types";
import { ipc } from "../lib/ipc";
import { useSkin } from "../hooks/useTheme";
import { getHighlighter, highlightCodeSync } from "../lib/shiki";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { FileTypeIcon } from "./ui/FileTypeIcon";
import type { FileTab } from "../stores/fileViewer";

export function FilePreview({ tab }: { tab: FileTab }) {
  const [file, setFile] = useState<FilePreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [markdownMode, setMarkdownMode] = useState<"preview" | "source">("preview");
  const [externalError, setExternalError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setExternalError(null);
    setMarkdownMode("preview");

    ipc
      .readFile(tab.projectId, tab.relativePath)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setFile(null);
          setError(result.error);
          return;
        }
        setFile(result.file);
      })
      .catch((err) => {
        if (cancelled) return;
        setFile(null);
        setError(String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tab.projectId, tab.relativePath, reloadKey]);

  const openExternal = async () => {
    setExternalError(null);
    const result = await ipc.openFileExternal(tab.projectId, tab.relativePath);
    if (!result.ok) setExternalError(result.error ?? "无法使用系统程序打开文件");
  };

  return (
    <main className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <header className="ui-glass flex h-[var(--c-layout-header)] shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <FileTypeIcon name={tab.name} size={17} />
          <span className="truncate text-body-lg font-medium text-text">{tab.name}</span>
          <span className="hidden min-w-0 truncate font-mono text-caption text-text-muted min-[1100px]:inline">
            {tab.relativePath}
          </span>
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-1">
          {file && (
            <span className="mr-1 hidden text-caption text-text-muted sm:inline">
              {formatBytes(file.size)}
              {file.truncated ? " · 已截断" : ""}
            </span>
          )}
          {file?.kind === "markdown" && (
            <div className="ui-ring mr-1 flex items-center rounded-md p-0.5">
              <button
                type="button"
                onClick={() => setMarkdownMode("preview")}
                title="预览 Markdown"
                className={`rounded px-1.5 py-1 ${
                  markdownMode === "preview"
                    ? "bg-surface-active text-text"
                    : "text-text-muted hover:text-text"
                }`}
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setMarkdownMode("source")}
                title="查看 Markdown 源码"
                className={`rounded px-1.5 py-1 ${
                  markdownMode === "source"
                    ? "bg-surface-active text-text"
                    : "text-text-muted hover:text-text"
                }`}
              >
                <FileCode2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
            title="重新读取文件"
            className="rounded p-2 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <RotateCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={openExternal}
            title="用系统默认程序打开"
            className="rounded p-2 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
        </div>
      </header>

      {externalError && (
        <div className="shrink-0 border-b border-error/30 bg-error-bg px-4 py-2 text-meta text-error">
          {externalError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <PreviewState
            icon={<Loader2 className="h-6 w-6 animate-spin" />}
            title="正在读取文件"
          />
        ) : error ? (
          <PreviewState
            icon={<AlertCircle className="h-7 w-7" />}
            title="无法打开文件"
            detail={error}
          />
        ) : file?.kind === "markdown" ? (
          markdownMode === "preview" ? (
            <div className="h-full overflow-y-auto p-5">
              <div className="mx-auto max-w-[var(--c-layout-content)]">
                <MarkdownRenderer content={file.content ?? ""} />
              </div>
            </div>
          ) : (
            <CodePreview code={file.content ?? ""} language={file.language ?? "markdown"} />
          )
        ) : file?.kind === "text" ? (
          <CodePreview code={file.content ?? ""} language={file.language ?? "text"} />
        ) : file?.kind === "image" && file.dataUrl ? (
          <div className="flex h-full items-center justify-center overflow-auto bg-surface-2 p-5">
            <img
              src={file.dataUrl}
              alt={file.name}
              className="max-h-full max-w-full rounded-md object-contain shadow-[var(--c-shadow-sm)]"
            />
          </div>
        ) : file?.kind === "pdf" && file.dataUrl ? (
          <embed
            src={file.dataUrl}
            type="application/pdf"
            className="h-full w-full"
            title={file.name}
          />
        ) : (
          <PreviewState
            icon={<FileTypeIcon name={tab.name} size={36} />}
            title="该文件暂不支持内置预览"
            detail={file?.note ?? "可以使用系统默认程序打开"}
            action={
              <button
                type="button"
                onClick={openExternal}
                className="ui-btn-primary rounded-md px-3 py-2 text-meta"
              >
                用系统默认程序打开
              </button>
            }
          />
        )}
      </div>
    </main>
  );
}

function CodePreview({ code, language }: { code: string; language: string }) {
  const { codeTheme } = useSkin();
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const render = () => {
      const html = highlightCodeSync(code, language, codeTheme);
      if (html) setHighlighted(stripPreTag(html));
    };

    render();
    getHighlighter().then(() => {
      if (!cancelled) render();
    });

    return () => {
      cancelled = true;
    };
  }, [code, language, codeTheme]);

  return (
    <div className="h-full overflow-auto p-4">
      {highlighted ? (
        <pre
          className="min-h-full whitespace-pre font-mono text-meta leading-relaxed"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre className="min-h-full whitespace-pre font-mono text-meta leading-relaxed text-text-secondary">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function PreviewState({
  icon,
  title,
  detail,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-text-muted">
      <span className="opacity-45">{icon}</span>
      <p className="text-body-lg text-text-secondary">{title}</p>
      {detail && <p className="max-w-md text-meta">{detail}</p>}
      {action}
    </div>
  );
}

function stripPreTag(html: string): string {
  return html.replace(/^<pre[^>]*>/, "").replace(/<\/pre>$/, "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
