/**
 * 字幕解析与转换
 *
 * 预览层只需要「起止时间 + 文本」，不需要完整实现字幕规范：
 * - SRT / WebVTT 走同一套时间轴解析；
 * - ASS / SSA 只取 [Events] 里的 Dialogue 行；
 * - SRT → WebVTT 只做最小转换（补文件头、时间分隔符逗号换点），
 *   这样同名视频可以直接用 <track> 挂载。
 *
 * 解析失败时不抛错：返回空数组，由调用方回退到源码视图。
 */

export type SubtitleFormat = "srt" | "vtt" | "ass" | "ssa";

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  /** 已去掉样式标签、保留原始换行的文本 */
  text: string;
}

/** 去掉 BOM 并统一换行 */
function normalize(raw: string): string {
  return raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** 解析 `hh:mm:ss,mmm` / `hh:mm:ss.mmm` / `mm:ss.mmm` */
function parseTimestamp(value: string): number | null {
  const match =
    /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;

  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4] ?? "0";
  const milliseconds = Number(fraction.padEnd(3, "0").slice(0, 3));

  return hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + milliseconds;
}

/** 去掉字幕里的样式标签（SRT 的 <i>、ASS 的 {\an8} 等） */
function cleanText(raw: string): string {
  return raw
    .replace(/\{[^}]*\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\N/gi, "\n")
    .replace(/\\n/gi, " ")
    .replace(/ /g, " ")
    .trim();
}

function parseSrtOrVtt(raw: string, format: "srt" | "vtt"): SubtitleCue[] {
  let text = normalize(raw);

  if (format === "vtt" && /^WEBVTT\b/i.test(text)) {
    // 头部可能带 WEBVTT 与 NOTE / STYLE / REGION 块：从第一个空行后开始
    const headerEnd = text.indexOf("\n\n");
    if (headerEnd >= 0) text = text.slice(headerEnd + 2);
  }

  const cues: SubtitleCue[] = [];

  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;

    const [startRaw, endRaw] = lines[timingIndex].split("-->");
    // 结束时间后面可能跟 cue settings（align:start 等）
    const endToken = (endRaw ?? "").trim().split(/\s+/)[0] ?? "";
    const startMs = parseTimestamp(startRaw ?? "");
    const endMs = parseTimestamp(endToken);
    if (startMs === null || endMs === null || endMs < startMs) continue;

    const body = cleanText(lines.slice(timingIndex + 1).join("\n"));
    if (!body) continue;

    cues.push({ startMs, endMs, text: body });
  }

  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** 解析 `H:MM:SS.cc` / `H:MM:SS.mmm`（ASS 用厘秒） */
function parseAssTimestamp(value: string): number | null {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;

  const fraction = match[4] ?? "0";
  // ASS 的两位小数是厘秒（1/100 秒），补零到毫秒
  const milliseconds =
    fraction.length <= 2
      ? Number(fraction.padEnd(2, "0")) * 10
      : Number(fraction.padEnd(3, "0").slice(0, 3));

  return (
    Number(match[1]) * 3_600_000 +
    Number(match[2]) * 60_000 +
    Number(match[3]) * 1_000 +
    milliseconds
  );
}

function parseAss(raw: string): SubtitleCue[] {
  const text = normalize(raw);
  const eventsStart = text.indexOf("[Events]");
  if (eventsStart < 0) return [];
  const section = text.slice(eventsStart);

  let fieldCount = 10;
  let startIndex = 1;
  let endIndex = 2;
  let textIndex = 9;

  const cues: SubtitleCue[] = [];

  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (/^Format\s*:/i.test(trimmed)) {
      const fields = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((field) => field.trim().toLowerCase());
      fieldCount = fields.length;
      startIndex = fields.indexOf("start");
      endIndex = fields.indexOf("end");
      textIndex = fields.indexOf("text");
      continue;
    }
    if (!/^Dialogue\s*:/i.test(trimmed)) continue;

    const payload = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    // Text 是最后一个字段，可能自带逗号，必须按字段数限切
    const parts = payload.split(",");
    if (parts.length < fieldCount) continue;
    const head = parts.slice(0, fieldCount - 1);
    head.push(parts.slice(fieldCount - 1).join(","));

    if (startIndex < 0 || endIndex < 0 || textIndex < 0) continue;

    const startMs = parseAssTimestamp(head[startIndex] ?? "");
    const endMs = parseAssTimestamp(head[endIndex] ?? "");
    if (startMs === null || endMs === null || endMs < startMs) continue;

    const body = cleanText(head[textIndex] ?? "");
    if (!body) continue;

    cues.push({ startMs, endMs, text: body });
  }

  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** 从文件名推断字幕格式；未知扩展名按 SRT 处理 */
export function subtitleFormatOf(fileName: string): SubtitleFormat {
  const index = fileName.lastIndexOf(".");
  const extension = index >= 0 ? fileName.slice(index + 1).toLowerCase() : "";
  return extension === "vtt" || extension === "ass" || extension === "ssa"
    ? extension
    : "srt";
}

export function parseSubtitle(raw: string, format: SubtitleFormat): SubtitleCue[] {
  try {
    return format === "ass" || format === "ssa"
      ? parseAss(raw)
      : parseSrtOrVtt(raw, format);
  } catch {
    return [];
  }
}

/**
 * SRT → WebVTT 的最小转换。
 *
 * WebVTT 允许数字 cue 标识，因此不用删除 SRT 的序号行；只需补文件头
 * 并把时间里的逗号换成点。已经是 WebVTT 时原样返回。
 */
export function srtToVtt(raw: string): string {
  const text = normalize(raw);
  if (/^WEBVTT\b/i.test(text)) return text;

  const converted = text.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g,
    "$1.$2",
  );
  return `WEBVTT\n\n${converted.trim()}\n`;
}

/** 时间轴展示：超过 1 小时才显示小时位 */
export function formatCueTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const millis = safe % 1_000;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const mmm = String(millis).padStart(3, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}.${mmm}` : `${mm}:${ss}.${mmm}`;
}
