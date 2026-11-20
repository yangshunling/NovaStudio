import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatCueTime,
  parseSubtitle,
  srtToVtt,
  subtitleFormatOf,
} from "../src/renderer/lib/subtitles.ts";

test("解析 SRT：时间、多行文本与排序", () => {
  const cues = parseSubtitle(
    [
      "2",
      "00:00:04,500 --> 00:00:06,000",
      "第二条",
      "",
      "1",
      "00:00:01,000 --> 00:00:03,250",
      "第一行",
      "第二行",
      "",
    ].join("\r\n"),
    "srt",
  );

  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], {
    startMs: 1000,
    endMs: 3250,
    text: "第一行\n第二行",
  });
  assert.deepEqual(cues[1], {
    startMs: 4500,
    endMs: 6000,
    text: "第二条",
  });
});

test("解析 WebVTT：跳过文件头、忽略 cue settings、去掉内联标签", () => {
  const cues = parseSubtitle(
    [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:03.000 align:start position:10%",
      "<v 张三>你好</v>",
      "",
    ].join("\n"),
    "vtt",
  );

  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 3000);
  assert.equal(cues[0].text, "你好");
});

test("解析 ASS：按 Format 字段定位，文本中的逗号不丢", () => {
  const cues = parseSubtitle(
    [
      "[Script Info]",
      "Title: demo",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,你好，世界",
      "Dialogue: 0,0:00:04.20,0:00:05.00,Default,,0,0,0,,{\\an8}第二句",
    ].join("\n"),
    "ass",
  );

  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 3500);
  assert.equal(cues[0].text, "你好，世界");
  assert.equal(cues[1].text, "第二句");
});

test("SRT 转 WebVTT：补文件头并把时间逗号换成点", () => {
  const vtt = srtToVtt(
    ["1", "00:00:01,000 --> 00:00:03,000", "Hello", ""].join("\r\n"),
  );

  assert.ok(vtt.startsWith("WEBVTT\n\n"));
  assert.ok(vtt.includes("00:00:01.000 --> 00:00:03.000"));
  assert.ok(!vtt.includes("00:00:01,000"));
});

test("已经是 WebVTT 时原样返回", () => {
  const source = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n";
  assert.equal(srtToVtt(source), source);
});

test("时间轴格式化：超过 1 小时才显示小时位", () => {
  assert.equal(formatCueTime(0), "00:00.000");
  assert.equal(formatCueTime(61_001), "01:01.001");
  assert.equal(formatCueTime(3_661_001), "1:01:01.001");
});

test("从文件名推断字幕格式", () => {
  assert.equal(subtitleFormatOf("movie.srt"), "srt");
  assert.equal(subtitleFormatOf("movie.VTT"), "vtt");
  assert.equal(subtitleFormatOf("movie.ass"), "ass");
  assert.equal(subtitleFormatOf("movie.ssa"), "ssa");
  assert.equal(subtitleFormatOf("movie.txt"), "srt");
});

test("无法识别的字幕返回空数组，不抛错", () => {
  assert.deepEqual(parseSubtitle("随便写点什么", "srt"), []);
  assert.deepEqual(parseSubtitle("", "ass"), []);
});
