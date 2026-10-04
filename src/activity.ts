import type { ActivityLine } from './channels/adapter.js';
import { stepSummary } from './ui/shared/activity-presentation.js';

export type ActivityStep =
  | { kind: 'tool'; id: string; tool: string; status: 'pending' | 'running' | 'completed' | 'error' | 'interrupted' | 'unknown'; detail?: string; title?: string; error?: string; durationMs?: number; rejectedBeforeExecution?: boolean }
  | { kind: 'internal'; id: string; text: string }
  | { kind: 'file'; id: string; path?: string; name?: string; mime?: string }
  | { kind: 'patch'; id: string; files: string[] }
  | { kind: 'retry'; id: string; attempt: number; error?: string }
  | { kind: 'compaction'; id: string; auto?: boolean }
  | { kind: 'subtask'; id: string; agent?: string; description?: string }
  | { kind: 'notification'; id: string; text: string; detail?: string };

export interface ReducedActivityLine extends ActivityLine {
  step: ActivityStep;
}

function parseStep(text: string): ActivityStep | null {
  try {
    const value = JSON.parse(text) as Partial<ActivityStep>;
    if (!value || typeof value.kind !== 'string' || typeof value.id !== 'string' || !value.id) return null;
    if (!['tool', 'internal', 'file', 'patch', 'retry', 'compaction', 'subtask', 'notification'].includes(value.kind)) return null;
    return value as ActivityStep;
  } catch {
    return null;
  }
}

/** Collapse lifecycle updates by kind + provider id while preserving first-seen order and timestamp. */
export function reduceActivityLines(lines: ActivityLine[]): ActivityLine[] {
  const reduced: ReducedActivityLine[] = [];
  const positions = new Map<string, number>();

  for (const line of lines) {
    const step = parseStep(line.text);
    if (!step) continue;
    const key = `${step.kind}\u0000${step.id}`;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, reduced.length);
      reduced.push({ ...line, step });
      continue;
    }
    const prior = reduced[position];
    let merged = { ...prior.step, ...step } as ActivityStep;
    if (
      merged.kind === 'tool' &&
      ['completed', 'error', 'interrupted', 'unknown'].includes(merged.status)
    ) {
      const startedAt = Number(prior.ts);
      const endedAt = Number(line.ts);
      if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt) {
        merged = { ...merged, durationMs: endedAt - startedAt };
      }
    }
    reduced[position] = { ts: prior.ts, text: JSON.stringify(merged), step: merged };
  }

  return reduced.map(({ ts, step }) => ({ ts, text: JSON.stringify(step) }));
}

export function activityHint(lines: ActivityLine[]): string | null {
  const reduced = reduceActivityLines(lines);
  for (let i = reduced.length - 1; i >= 0; i--) {
    const step = parseStep(reduced[i].text);
    if (!step) continue;
    const label = activityLabel(step);
    if (label) return label;
  }
  return null;
}

/** Canonical plain-text primary label used by typing hints. */
export function activityLabel(step: ActivityStep): string {
  return stepSummary(step);
}
