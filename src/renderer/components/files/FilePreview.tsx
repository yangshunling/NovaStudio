/**
 * 项目文件只读预览
 *
 * 文本 / 代码 / SVG / 字幕使用 Shiki 或专用视图；Markdown、HTML、SVG 可以在
 * 「渲染 / 源码」之间切换（HTML 走沙箱 iframe）。图片、PDF、音视频统一通过
 * nova-preview:// 从磁盘流式读取；字体交给 FontFace；未知二进制显示十六进制。
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
import { FontPreview, HexPreview, SubtitlePreview } from "./PreviewExtras";
import { subtitleFormatOf, srtToVtt } from "../../lib/subtitles";
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
  /** Markdown / HTML 的渲染与源码切换；切换文件时重置为渲染 */
  const [documentMode, setDocumentMode] = useState<"preview" | "source">(
    "preview",
  );
  const [externalError, setExternalError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const [subtitleTrackUrl, setSubtitleTrackUrl] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setExternalError(null);
    setMediaError(false);
    setDocumentMode("preview");

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

  /*
   * PDF 不能直接把 nova-preview:// 交给 <embed>：Chromium 的 PDF 查看器
   * 只接管 http(s)/file/blob 等 URL，自定义协议会得到空白框。
   * 先把字节拉下来做成 Blob URL，实测 12MB 级别也能立即渲染。
   */
  useEffect(() => {
    if (file?.kind !== "pdf") {
      setPdfUrl(null);
      setPdfError(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setPdfUrl(null);
    setPdfError(null);

    fetch(previewUrl(tab.projectId, tab.relativePath))
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfUrl(objectUrl);
      })
      .catch((err) => {
        if (!cancelled) setPdfError(String(err));
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, tab.projectId, tab.relativePath]);

  /*
   * 视频同名字幕自动挂载：
   * - .vtt 可以原样作为 <track>；
   * - .srt 先拉下来转成 WebVTT，再用 Blob URL 交给 <track>。
   */
  useEffect(() => {
    setSubtitleTrackUrl(null);
    if (file?.kind !== "video" || !file.subtitlePath) return;

    const url = previewUrl(tab.projectId, file.subtitlePath);
    if (file.subtitleKind === "vtt") {
      setSubtitleTrackUrl(url);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(
          new Blob([srtToVtt(text)], { type: "text/vtt" }),
        );
        setSubtitleTrackUrl(objectUrl);
      })
      .catch(() => {
        // 字幕加载失败不影响视频本身
        if (!cancelled) setSubtitleTrackUrl(null);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, tab.projectId]);

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
        hue="teal"
        subtitle={tab.relativePath}
        actions={
          <>
            {file && (
              <span className="mr-1 hidden ui-type-note text-text-muted sm:inline">
                {formatBytes(file.size)}
                {file.truncated ? " · 已截断" : ""}
              </span>
            )}
            {(file?.kind === "markdown" ||
              file?.kind === "html" ||
              file?.kind === "svg") && (
              <SegmentedTabs
                size="sm"
                value={documentMode}
                onChange={setDocumentMode}
                className="mr-1"
                options={[
                  {
                    id: "preview",
                    label: <Eye className="h-3.5 w-3.5" />,
                    title: `预览 ${
                      file.kind === "html"
                        ? "HTML 页面"
                        : file.kind === "svg"
                          ? "SVG 图片"
                          : "Markdown"
                    }`,
                  },
                  {
                    id: "source",
                    label: <FileCode2 className="h-3.5 w-3.5" />,
                    title: `查看 ${
                      file.kind === "html"
                        ? "HTML"
                        : file.kind === "svg"
                          ? "SVG"
                          : "Markdown"
                    } 源码`,
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
        ) : (file?.kind === "markdown" ||
          file?.kind === "html" ||
          file?.kind === "svg") ? (
          documentMode === "preview" ? (
            file.kind === "markdown" ? (
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
            ) : file.kind === "svg" ? (
              <div className="flex h-full items-center justify-center overflow-auto bg-surface-2 p-section">
                <img
                  src={previewUrl(tab.projectId, tab.relativePath)}
                  alt={file.name}
                  className="max-h-full max-w-full rounded-md object-contain shadow-[var(--c-shadow-sm)]"
                />
              </div>
            ) : (
              /*
               * HTML 用沙箱 iframe 渲染：
               * - 不用 dangerouslySetInnerHTML：页面里的脚本 / 样式会直接
               *   进入宿主 DOM，既可能污染界面，也拿不到独立的视口滚动；
               * - sandbox 只给 allow-scripts，不给 allow-same-origin：
               *   页面能正常跑自己的脚本，但处于不透明源，读不到宿主状态；
               * - src 走 nova-preview://<projectId>/<相对路径>，页面内的
               *   ./style.css 等相对资源因此能按同一项目解析。
               */
              <iframe
                key={`${tab.projectId}:${tab.relativePath}:${reloadKey}`}
                src={previewDocumentUrl(tab.projectId, tab.relativePath)}
                title={file.name}
                sandbox="allow-scripts"
                className="h-full w-full border-0 bg-white"
              />
            )
          ) : (
            <CodePreview
              code={file.content ?? ""}
              language={
                file.kind === "svg"
                  ? "xml"
                  : (file.language ?? (file.kind === "html" ? "html" : "markdown"))
              }
            />
          )
        ) : file?.kind === "text" ? (
          <CodePreview code={file.content ?? ""} language={file.language ?? "text"} />
        ) : file?.kind === "subtitle" ? (
          <SubtitlePreview
            content={file.content ?? ""}
            format={subtitleFormatOf(file.name)}
            fallback={
              <CodePreview code={file.content ?? ""} language="text" />
            }
          />
        ) : file?.kind === "font" ? (
          <FontPreview url={previewUrl(tab.projectId, tab.relativePath)} />
        ) : (file?.kind === "audio" || file?.kind === "video") ? (
          mediaError ? (
            <PreviewState
              icon={<AlertCircle className="h-7 w-7" />}
              title={`无法播放该${file.kind === "audio" ? "音频" : "视频"}`}
              detail="Chromium 可能不支持该文件使用的编码（如 HEVC / AC-3），可以换用系统默认程序播放。"
              action={
                <Button variant="primary" size="sm" onClick={openExternal}>
                  用系统默认程序打开
                </Button>
              }
            />
          ) : file.kind === "audio" ? (
            <div className="flex h-full items-center justify-center bg-surface-2 p-section">
              <audio
                key={`${tab.projectId}:${tab.relativePath}:${reloadKey}`}
                controls
                preload="metadata"
                src={previewUrl(tab.projectId, tab.relativePath)}
                className="w-full max-w-xl"
                onError={() => setMediaError(true)}
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center overflow-auto bg-surface-2 p-section">
              <video
                key={`${tab.projectId}:${tab.relativePath}:${reloadKey}`}
                controls
                preload="metadata"
                src={previewUrl(tab.projectId, tab.relativePath)}
                className="max-h-full max-w-full rounded-md shadow-[var(--c-shadow-sm)]"
                onError={() => setMediaError(true)}
              >
                {subtitleTrackUrl && (
                  <track
                    key={subtitleTrackUrl}
                    kind="subtitles"
                    src={subtitleTrackUrl}
                    default
                  />
                )}
              </video>
            </div>
          )
        ) : file?.kind === "image" ? (
          <div className="flex h-full items-center justify-center overflow-auto bg-surface-2 p-section">
            <img
              src={previewUrl(tab.projectId, tab.relativePath)}
              alt={file.name}
              className="max-h-full max-w-full rounded-md object-contain shadow-[var(--c-shadow-sm)]"
            />
          </div>
        ) : file?.kind === "pdf" ? (
          pdfError ? (
            <PreviewState
              icon={<AlertCircle className="h-7 w-7" />}
              title="无法加载 PDF"
              detail={pdfError}
              action={
                <Button variant="primary" size="sm" onClick={openExternal}>
                  用系统默认程序打开
                </Button>
              }
            />
          ) : pdfUrl ? (
            <embed
              src={pdfUrl}
              type="application/pdf"
              className="h-full w-full"
              title={file.name}
            />
          ) : (
            <PreviewState
              icon={<Spinner className="h-6 w-6" />}
              title="正在加载 PDF"
              detail={formatBytes(file.size)}
            />
          )
        ) : file?.kind === "binary" &&
          !file.mimeType.startsWith("image/") &&
          file.mimeType !== "application/pdf" ? (
          /*
           * 未知二进制（exe / dll / zip / docx…）至少能看到文件头；
           * 超大图片 / PDF 仍走下面的兜底，十六进制对它们没有意义。
           */
          <HexPreview
            url={previewUrl(tab.projectId, tab.relativePath)}
            size={file.size}
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

/**
 * 图片 / PDF 交给主进程的 nova-preview:// 协议按需流式读取。
 *
 * 不用 data URL：Chromium 的 URL 长度上限是 2MB（base64 还会膨胀 4/3），
 * 超过后 <img>/<embed> 会静默失败，预览区只剩白框。
 */
function previewUrl(projectId: string, relativePath: string): string {
  const name = relativePath.split(/[\\/]/).pop() || "file";
  const params = new URLSearchParams({ project: projectId, path: relativePath });
  return `nova-preview://file/${encodeURIComponent(name)}?${params.toString()}`;
}

/**
 * HTML 文档的预览地址：项目 id 放在 host 上。
 *
 * 页面里的相对资源引用（./style.css、../img/a.png）解析后仍落在同一个
 * host，主进程据此知道是哪个项目，从而正确读取工作区里的其它文件。
 */
function previewDocumentUrl(projectId: string, relativePath: string): string {
  const path = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `nova-preview://${projectId}/${path}`;
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
