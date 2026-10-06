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

export function technicalSummary({
  elapsedMs,
  usage,
}: {
  elapsedMs: number | null;
  usage: readonly Partial<ConversationUsage>[];
}): string {
  const costs = usage.map((record) => record.cost_usd);
  const cost =
    costs.length && costs.every((value): value is number => value !== undefined)
      ? costs.reduce((total, value) => total + value, 0)
      : null;
  const context = [...usage]
    .reverse()
    .find(
      (record) =>
        record.context_tokens !== undefined &&
        record.context_window !== undefined &&
        record.context_window > 0 &&
        record.context_tokens >= 0 &&
        record.context_tokens <= record.context_window,
    );
  return [
    formatDuration(elapsedMs),
    cost !== null && cost !== 0 ? formatUsageCost(cost) : '',
    context?.context_tokens !== undefined && context.context_window !== undefined
      ? `${formatContextPercent(context.context_tokens, context.context_window)} ctx`
      : '',
  ]
    .filter(Boolean)
    .join(' \u00b7 ');
}
