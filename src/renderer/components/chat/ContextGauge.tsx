/**
 * 上下文占用仪表
 *
 * 输入区底部工具条里的横向小标尺：
 *
 *   上下文 ▓▓▓▓░░░░░░ 42%
 *
 * 比圆环更易读，也不和发送按钮抢视觉。读数口径：
 * - 标尺 = 最近一次 API 调用的上下文占用 / 模型窗口上限；
 * - 70% 起转琥珀、90% 起转错误色，标尺与数字同步；
 * - hover 展开本轮输入 / 缓存 / 输出、会话累计与费用。
 *
 * 颜色全部取自现有 accent / agent-amber / error，换肤自动跟随。
 */

import { useMemo } from "react";
import { useAgentSettings } from "../../stores/agentSettings";
import { clamp } from "@shared/math";
import type { SessionUsage } from "../../stores/chat";

/** 模型配置里的上下文后缀：1M / 200K / 1m → 具体 token 数 */
function parseContextWindow(context: string): number | null {
  const match = context.trim().match(/^(\d+(?:\.\d+)?)\s*([km])$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * (match[2].toUpperCase() === "M" ? 1_000_000 : 1_000));
}

/** 紧凑计数：12400 → 12.4k，1500000 → 1.5m */
function compact(value: number): string {
  const format = (scaled: number, unit: string): string =>
    `${scaled.toFixed(scaled >= 100 ? 0 : 1).replace(/\.0$/, "")}${unit}`;
  if (value >= 1_000_000) return format(value / 1_000_000, "m");
  if (value >= 1_000) return format(value / 1_000, "k");
  return String(value);
}

/** 完整计数：用于「已用 / 上限」这种需要精确值的读数 */
function full(value: number): string {
  return value.toLocaleString("zh-CN");
}

export function ContextGauge({
  usage,
  agentId,
  model,
}: {
  usage: SessionUsage | null;
  agentId: string;
  /** 会话级模型覆盖；有值时按它解析上下文窗口，而不是 Agent 默认模型 */
  model?: string | null;
}) {
  /*
   * CLI 的 modelUsage.contextWindow 不是每个版本 / 网关都有。
   * 没有时从本机模型配置的上下文后缀（如 1M）补齐，
   * 否则 1M 模型会被按默认 200k 计算，直接算出 122%。
   */
  const settings = useAgentSettings(agentId);
  const configuredMax = useMemo(() => {
    /*
     * 会话指定了模型时，窗口上限跟着会话走：
     * 同一 Agent 下 1M 模型和 200K 模型不能共用一份缓存。
     */
    if (model) {
      const suffix = model.match(/\[([^\]]+)\]\s*$/)?.[1] ?? "";
      return parseContextWindow(suffix);
    }
    if (!settings) return null;
    return parseContextWindow(settings.defaultModel.context);
  }, [model, settings]);

  if (!usage || usage.contextUsed <= 0) return null;

  // CLI 明确报告过窗口大小就以它为准；否则用模型配置覆盖默认值
  const contextMax = usage.contextMaxReported
    ? usage.contextMax
    : (configuredMax ?? usage.contextMax);
  const ratio = contextMax > 0 ? usage.contextUsed / contextMax : 0;
  const clamped = clamp(ratio, 0, 1);
  // 已用但不足 1% 时显示 1%，避免「有占用却写 0%」的观感
  const percent = Math.max(1, Math.round(ratio * 100));
  const tone =
    ratio >= 0.9
      ? "text-error"
      : ratio >= 0.7
        ? "text-agent-amber"
        : "text-accent";
  const fill =
    ratio >= 0.9
      ? "bg-error"
      : ratio >= 0.7
        ? "bg-agent-amber"
        : "bg-accent";

  /*
   * 圆环进度：体积小但比横条更醒目，作为工具栏里的常驻状态读数。
   * 半径留出线宽，避免描边被 viewBox 裁掉。
   */
  const ringSize = 18;
  const ringStroke = 2.8;
  const ringRadius = (ringSize - ringStroke) / 2;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset = ringCircumference * (1 - clamped);
  const strokeTone =
    ratio >= 0.9
      ? "stroke-error"
      : ratio >= 0.7
        ? "stroke-agent-amber"
        : "stroke-accent";

  const latestCache =
    usage.contextCacheCreationInputTokens + usage.contextCacheReadInputTokens;
  const hasSnapshot = usage.contextInputTokens + latestCache > 0;
  const cumulative =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;

  return (
    <div
      className="group relative flex h-8 shrink-0 items-center gap-2"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={contextMax}
      aria-valuenow={usage.contextUsed}
      aria-label="上下文窗口占用"
      title={`上下文 ${full(usage.contextUsed)} / ${full(contextMax)} tokens（${percent}%）`}
    >
      <svg
        width={ringSize}
        height={ringSize}
        viewBox={`0 0 ${ringSize} ${ringSize}`}
        className="-rotate-90 shrink-0"
        aria-hidden="true"
      >
        <circle
          cx={ringSize / 2}
          cy={ringSize / 2}
          r={ringRadius}
          fill="none"
          strokeWidth={ringStroke}
          className="stroke-border"
        />
        <circle
          cx={ringSize / 2}
          cy={ringSize / 2}
          r={ringRadius}
          fill="none"
          strokeWidth={ringStroke}
          strokeLinecap="round"
          strokeDasharray={`${ringCircumference} ${ringCircumference}`}
          strokeDashoffset={ringOffset}
          className={`${strokeTone} transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none`}
        />
      </svg>

      <span className={`ui-type-code-sm tabular-nums ${tone}`}>
        {percent}%
      </span>

      {/* 悬停明细：不占布局，向上展开 */}
      <div className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 w-72 rounded-lg border border-border/70 bg-surface p-3 opacity-0 shadow-[var(--c-shadow)] transition-opacity duration-150 group-hover:opacity-100">
        <div className="flex items-baseline justify-between gap-2">
          <span className="ui-type-sub text-text-muted">上下文窗口</span>
          <span className={`ui-type-code-sm tabular-nums ${tone}`}>
            {percent}%
          </span>
        </div>

        <div className="mt-1 ui-type-code tabular-nums text-text">
          {full(usage.contextUsed)}
          <span className="text-text-muted">
            {" / "}
            {full(contextMax)}
          </span>
        </div>

        <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-hover">
          <div
            className={`h-full rounded-full ${fill}`}
            style={{ width: `${clamped * 100}%` }}
          />
        </div>

        <div className="mt-3 space-y-1 ui-type-sub text-text-muted">
          {hasSnapshot && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="shrink-0">本轮</span>
              <span className="whitespace-nowrap font-mono tabular-nums text-text-secondary">
                {compact(usage.contextInputTokens)} 输入
                {latestCache > 0 && <> · {compact(latestCache)} 缓存</>}
              </span>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-2">
            <span className="shrink-0">会话累计</span>
            <span className="whitespace-nowrap font-mono tabular-nums text-text-secondary">
              {compact(cumulative)} tokens · {usage.turns} 轮
            </span>
          </div>
          {usage.costUsd > 0 && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="shrink-0">费用</span>
              <span className="whitespace-nowrap font-mono tabular-nums text-text-secondary">
                ${usage.costUsd.toFixed(4)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
