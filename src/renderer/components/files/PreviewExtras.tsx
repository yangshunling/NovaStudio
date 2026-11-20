/**
 * 文件预览的扩展视图
 *
 * - FontPreview：用 FontFace 加载 ttf / otf / woff / woff2，展示样张；
 * - SubtitlePreview：把 srt / vtt / ass 解析成时间轴；
 * - HexPreview：未知二进制按前 32KB 做十六进制查看。
 *
 * 三者都不引入依赖：字体和字幕是浏览器原生能力，十六进制只读字节。
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { formatBytes } from "../../lib/utils";
import { formatCueTime, parseSubtitle, type SubtitleFormat } from "../../lib/subtitles";
import { Spinner } from "../ui/Spinner";

// ============================================================================
// 字体
// ============================================================================

const SAMPLE_LATIN = "The quick brown fox jumps over the lazy dog";
const SAMPLE_CJK = "永和九年，岁在癸丑，暮春之初，会于会稽山阴之兰亭。";
const SAMPLE_SYMBOLS = "0123456789 !@#$%^&*() {} [] <> ?/\\ ©®™ αβγπ";

const FONT_SIZES = [16, 20, 24, 32, 48, 64] as const;

export function FontPreview({ url }: { url: string }) {
  /** 每个预览实例用独立的 family，避免与系统字体或其他预览串味 */
  const [family] = useState(
    () => `nova-preview-font-${Math.random().toString(36).slice(2, 10)}`,
  );
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let alive = true;
    const face = new FontFace(family, `url("${url}")`);
    setState("loading");

    face
      .load()
      .then((loaded) => {
        if (!alive) return;
        document.fonts.add(loaded);
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("error");
      });

    return () => {
      alive = false;
      try {
        document.fonts.delete(face);
      } catch {
        // 字体没加载成功时 delete 也可能失败，忽略
      }
    };
  }, [family, url]);

  if (state === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-text-muted">
        <p className="ui-type-item text-text-secondary">字体加载失败</p>
        <p className="max-w-md ui-type-note">
          文件可能已损坏，或使用了 Chromium 不支持的字体格式。
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-surface-2 p-section">
      <div className="mx-auto max-w-[var(--c-layout-content)] space-y-4">
        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 ui-type-note text-text-muted">
          {state === "loading" ? (
            <>
              <Spinner className="h-4 w-4" />
              正在加载字体…
            </>
          ) : (
            <>
              <span
                className="grid h-9 w-9 place-items-center rounded-md border border-border bg-surface-2 text-text"
                style={{ fontFamily: family, fontSize: 20 }}
              >
                Aa
              </span>
              字体已加载，下面是不同字号的渲染效果
            </>
          )}
        </div>

        <div
          className="rounded-lg border border-border bg-surface p-6"
          style={{ fontFamily: family }}
        >
          <div className="text-text" style={{ fontSize: 64, lineHeight: 1.15 }}>
            Aa 字体
          </div>
          <div className="mt-2 break-words text-text-secondary" style={{ fontSize: 24 }}>
            {SAMPLE_CJK}
          </div>
        </div>

        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {FONT_SIZES.map((size) => (
            <div key={size} className="flex gap-5 px-4 py-3">
              <span className="w-12 shrink-0 pt-1 tabular-nums ui-type-code text-text-muted">
                {size}px
              </span>
              <div
                className="min-w-0 flex-1 break-words text-text-secondary"
                style={{ fontFamily: family, fontSize: size, lineHeight: 1.4 }}
              >
                {SAMPLE_LATIN}
              </div>
            </div>
          ))}
        </div>

        <div
          className="space-y-2 rounded-lg border border-border bg-surface p-4 text-text-secondary"
          style={{ fontFamily: family, fontSize: 18, lineHeight: 1.7 }}
        >
          <p className="break-words">{SAMPLE_CJK}</p>
          <p className="break-words text-text-muted">{SAMPLE_SYMBOLS}</p>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 字幕
// ============================================================================

export function SubtitlePreview({
  content,
  format,
  fallback,
}: {
  content: string;
  format: SubtitleFormat;
  /** 一条都解析不出来时显示的源码视图 */
  fallback: ReactNode;
}) {
  const cues = useMemo(() => parseSubtitle(content, format), [content, format]);

  if (cues.length === 0) return <>{fallback}</>;

  const lastEnd = cues[cues.length - 1].endMs;

  return (
    <div className="h-full overflow-y-auto p-section">
      <div className="mx-auto max-w-[var(--c-layout-content)]">
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 ui-type-note text-text-muted">
          <span>{cues.length} 条字幕</span>
          <span>总时长 {formatCueTime(lastEnd)}</span>
          <span className="uppercase">{format}</span>
        </div>

        <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {cues.map((cue, index) => (
            <li key={`${cue.startMs}-${index}`} className="flex gap-5 px-4 py-2.5">
              <span className="w-32 shrink-0 pt-0.5 tabular-nums ui-type-code text-text-muted">
                {formatCueTime(cue.startMs)}
                <span className="block text-text-muted/60">
                  {formatCueTime(cue.endMs)}
                </span>
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-line break-words ui-type-item text-text-secondary">
                {cue.text}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// ============================================================================
// 十六进制
// ============================================================================

/** 只读前 32KB：足够看清文件头，也不会让大文件卡住渲染 */
const HEX_LIMIT = 32 * 1024;

async function readPrefix(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.slice(0, limit);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    const remain = limit - total;
    const slice = value.length > remain ? value.subarray(0, remain) : value;
    chunks.push(slice);
    total += slice.length;
    if (total >= limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function HexPreview({ url, size }: { url: string; size: number }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setError(null);

    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return readPrefix(response, HEX_LIMIT);
      })
      .then((data) => {
        if (!cancelled) setBytes(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  const rows = useMemo(() => {
    if (!bytes) return [];
    const result: { offset: string; hex: string; ascii: string }[] = [];

    for (let start = 0; start < bytes.length; start += 16) {
      const slice = bytes.subarray(start, start + 16);
      const hex = Array.from({ length: 16 }, (_, index) =>
        index < slice.length ? slice[index].toString(16).padStart(2, "0") : "  ",
      ).join(" ");
      const ascii = Array.from(slice)
        .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "."))
        .join("");
      result.push({
        offset: start.toString(16).padStart(8, "0"),
        hex,
        ascii,
      });
    }

    return result;
  }, [bytes]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-text-muted">
        <p className="ui-type-item text-text-secondary">无法读取文件</p>
        <p className="max-w-md ui-type-note">{error}</p>
      </div>
    );
  }

  if (!bytes) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-text-muted">
        <Spinner className="h-4 w-4" />
        正在读取文件头…
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-surface-2">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-surface/95 px-4 py-2 ui-type-note text-text-muted backdrop-blur">
        <span className="text-text-secondary">十六进制预览</span>
        <span>
          显示前 {formatBytes(bytes.length)}
          {size > bytes.length ? ` / 共 ${formatBytes(size)}` : ""}
        </span>
      </div>

      <pre className="min-w-max px-4 py-3 ui-type-code leading-relaxed">
        {rows.map((row) => (
          <div key={row.offset} className="flex gap-4">
            <span className="select-none text-text-muted/70">{row.offset}</span>
            <span className="text-text-secondary">{row.hex}</span>
            <span className="text-text-muted">{row.ascii}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
