import type { ActivityLine } from './channels/adapter.js';

export type ActivityStep =
  | {
      kind: 'tool';
      id: string;
      tool: string;
      status: 'pending' | 'running' | 'completed' | 'error' | 'interrupted' | 'unknown';
      detail?: string;
      description?: string;
      title?: string;
      error?: string;
      durationMs?: number;
      rejectedBeforeExecution?: boolean;
    }
  | { kind: 'internal'; id: string; text: string }
  | { kind: 'file'; id: string; path?: string; name?: string; mime?: string }
  | { kind: 'patch'; id: string; files: string[] }
  | { kind: 'retry'; id: string; attempt: number; error?: string }
  | {
      kind: 'compaction';
      id: string;
      auto?: boolean;
      status?: 'running' | 'completed' | 'error' | 'interrupted' | 'unknown';
      detail?: string;
      error?: string;
      durationMs?: number;
    }
  | { kind: 'subtask'; id: string; agent?: string; description?: string }
  | { kind: 'notification'; id: string; text: string; detail?: string }
  | { kind: 'model'; id: string; durationMs: number };

export interface ReducedActivityLine extends ActivityLine {
  step: ActivityStep;
}

function parseStep(text: string): { key: string; step: ActivityStep | null } | null {
  try {
    const value = JSON.parse(text) as Partial<ActivityStep>;
    if (!value || typeof value.kind !== 'string' || typeof value.id !== 'string') return null;
    return {
      key: JSON.stringify([value.kind, value.id]),
      step:
        value.id &&
        ['tool', 'internal', 'file', 'patch', 'retry', 'compaction', 'subtask', 'notification', 'model'].includes(
          value.kind,
        )
          ? (value as ActivityStep)
          : null,
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

function reducedActivity<T extends { ts: string | number; text: string }>(lines: T[]) {
  const groups = new Map<string, { lines: T[]; step: ActivityStep | null }>();
  for (const [index, line] of lines.entries()) {
    const parsed = parseStep(line.text);
    const key = parsed?.key ?? `line:${index}`;
    const prior = groups.get(key);
    if (!prior) {
      groups.set(key, { lines: [line], step: parsed?.step ?? null });
      continue;
    }
    if (!parsed?.step) {
      prior.lines.push(line);
      continue;
    }
    let merged = { ...prior.step, ...parsed.step } as ActivityStep;
    if (
      (merged.kind === 'tool' || merged.kind === 'compaction') &&
      merged.status !== undefined &&
      ['completed', 'error', 'interrupted', 'unknown'].includes(merged.status)
    ) {
      const startedAt = Number(prior.lines[0].ts);
      const endedAt = Number(line.ts);
      if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt) {
        merged = { ...merged, durationMs: endedAt - startedAt };
      }
    }
    prior.step = merged;
  }
  return [...groups.values()];
}

/** Channel labels omit unrecognized activity and retain first-seen timestamps. */
export function reduceActivityLines<T extends { ts: string | number; text: string }>(
  lines: T[],
): { ts: T['ts']; text: string }[] {
  return reducedActivity(lines).flatMap(({ lines: [first], step }) =>
    step ? [{ ts: first.ts, text: JSON.stringify(step) }] : [],
  );
}

/** Conversation traces retain first-seen positions and all unrecognized history. */
export function reduceConversationActivity<T extends { ts: string | number; text: string }>(lines: T[]): T[] {
  return reducedActivity(lines).flatMap(({ lines, step }) =>
    step ? [{ ...lines[0], text: JSON.stringify(step) }] : lines,
  );
}
