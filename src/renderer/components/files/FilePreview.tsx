/**
 * 项目文件只读预览
 *
 * 文本 / 代码使用 Shiki，Markdown 可切换预览与源码，
 * 图片与 PDF 使用主进程返回的 data URL，其他类型回退到系统默认程序。
 */

import { useEffect, useState } from "react";
import {
  AlertCircle, ExternalLink, Eye, FileCode2, RotateCw, X } from "lucide-react";
import type {
  FilePreview as FilePreviewData,
} from "@shared/types";
import { ipc } from "../../lib/ipc";
import { useSkin } from "../../hooks/useTheme";
import { getHighlighter, highlightCodeSync } from "../../lib/shiki";
import { formatBytes, stripPreTag } from "../../lib/utils";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { Button } from "../ui/Button";
import { FileTypeIcon } from "../ui/FileTypeIcon";
import { IconButton } from "../ui/IconButton";
import { PageHeader } from "../ui/Page";
import { SegmentedTabs } from "../ui/SegmentedTabs";
import type { FileTab } from "../../stores/fileViewer";
import { Spinner } from "../ui/Spinner";

export function FilePreview({
  tab,
  onClose,
}: {
  tab: FileTab;
  /** 传入时在标题栏末尾展示关闭按钮 */
  onClose?: () => void;
}) {
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
      <PageHeader
        icon={<FileTypeIcon name={tab.name} size={17} />}
        title={tab.name}
        subtitle={tab.relativePath}
        actions={
          <>
            {file && (
              <span className="mr-1 hidden ui-type-note text-text-muted sm:inline">
                {formatBytes(file.size)}
                {file.truncated ? " · 已截断" : ""}
              </span>
            )}
            {file?.kind === "markdown" && (
              <SegmentedTabs
                size="sm"
                value={markdownMode}
                onChange={setMarkdownMode}
                className="mr-1"
                options={[
                  {
                    id: "preview",
                    label: <Eye className="h-3.5 w-3.5" />,
                    title: "预览 Markdown",
                  },
                  {
                    id: "source",
                    label: <FileCode2 className="h-3.5 w-3.5" />,
                    title: "查看 Markdown 源码",
                  },
                ]}
              />
            )}
            <IconButton
              icon={<RotateCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />}
              label="重新读取文件"
              tone="muted"
              onClick={() => setReloadKey((value) => value + 1)}
            />
            <IconButton
              icon={<ExternalLink className="h-4 w-4" />}
              label="用系统默认程序打开"
              tone="muted"
              onClick={openExternal}
            />
            {onClose && (
              <IconButton
                icon={<X className="h-4 w-4" />}
                label="关闭预览"
                tone="muted"
                onClick={onClose}
              />
            )}
          </>
        }
      />

      {externalError && (
        <div className="shrink-0 border-b border-error/30 bg-error-bg px-4 py-2 ui-type-note text-error">
          {externalError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <PreviewState
            icon={<Spinner className="h-6 w-6" />}
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
            <div className="h-full overflow-y-auto p-section">
              <div className="mx-auto max-w-[var(--c-layout-content)]">
                <MarkdownRenderer
                  content={file.content ?? ""}
                  projectId={tab.projectId}
                  markdownPath={tab.relativePath}
                  allowHtml
                />
              </div>
            </div>
          ) : (
            <CodePreview code={file.content ?? ""} language={file.language ?? "markdown"} />
          )
        ) : file?.kind === "text" ? (
          <CodePreview code={file.content ?? ""} language={file.language ?? "text"} />
        ) : file?.kind === "image" && file.dataUrl ? (
          <div className="flex h-full items-center justify-center overflow-auto bg-surface-2 p-section">
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
              <Button variant="primary" size="sm" onClick={openExternal}>
                用系统默认程序打开
              </Button>
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
          className="min-h-full whitespace-pre ui-type-code leading-relaxed"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre className="min-h-full whitespace-pre ui-type-code leading-relaxed text-text-secondary">
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
      <p className="ui-type-item text-text-secondary">{title}</p>
      {detail && <p className="max-w-md ui-type-note">{detail}</p>}
      {action}
    </div>
  );
}
