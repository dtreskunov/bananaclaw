import type { ConversationUsage } from '../../../shared/conversation';
import { formatDuration } from './duration-format';

export function formatUsageCost(usd: number): string {
  if (usd >= 1) return '$' + usd.toFixed(2);
  if (usd >= 0.01) return '$' + usd.toFixed(3);
  return '$' + usd.toFixed(4);
}

export function formatContextPercent(used: number, limit: number): string {
  const pct = (used / limit) * 100;
  if (pct > 0 && pct < 1) return '<1%';
  return Math.min(100, Math.round(pct)) + '%';
}

export interface KnownContext {
  context_tokens: number;
  context_window: number;
  num_turns?: number;
}

export function latestContextUsage(usage: readonly Partial<ConversationUsage>[]): KnownContext | null {
  return (
    [...usage]
      .reverse()
      .find(
        (record): record is KnownContext =>
          record.context_tokens !== undefined &&
          record.context_window !== undefined &&
          Number.isFinite(record.context_tokens) &&
          Number.isFinite(record.context_window) &&
          record.context_window > 0 &&
          record.context_tokens >= 0 &&
          record.context_tokens <= record.context_window,
      ) ?? null
  );
}

export function selectContextUsage(
  usage: readonly Partial<ConversationUsage>[],
  liveUsage: Partial<ConversationUsage> | null = null,
): KnownContext | null {
  const recorded = latestContextUsage(usage);
  const live = liveUsage ? latestContextUsage([liveUsage]) : null;
  return live &&
    (live.num_turns === undefined || recorded?.num_turns === undefined || live.num_turns >= recorded.num_turns)
    ? live
    : recorded;
}

export function technicalSummary({
  elapsedMs,
  usage,
  context = latestContextUsage(usage),
}: {
  elapsedMs: number | null;
  usage: readonly Partial<ConversationUsage>[];
  context?: KnownContext | null;
}): string {
  const costs = usage.map((record) => record.cost_usd);
  const cost =
    costs.length && costs.every((value): value is number => value !== undefined)
      ? costs.reduce((total, value) => total + value, 0)
      : null;
  return [
    formatDuration(elapsedMs),
    cost !== null && cost !== 0 ? formatUsageCost(cost) : '',
    context ? `${formatContextPercent(context.context_tokens, context.context_window)} ctx` : '',
  ]
    .filter(Boolean)
    .join(' \u00b7 ');
}
