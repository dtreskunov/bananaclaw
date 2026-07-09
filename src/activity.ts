import type { ActivityLine } from './channels/adapter.js';

export type ActivityStep =
  | { kind: 'tool'; id: string; tool: string; status: 'pending' | 'running' | 'completed' | 'error'; detail?: string; title?: string; error?: string; durationMs?: number }
  | { kind: 'reasoning'; id: string; text: string }
  | { kind: 'file'; id: string; path?: string; name?: string; mime?: string }
  | { kind: 'patch'; id: string; files: string[] }
  | { kind: 'retry'; id: string; attempt: number; error?: string }
  | { kind: 'compaction'; id: string; auto?: boolean }
  | { kind: 'subtask'; id: string; agent?: string; description?: string }
  | { kind: 'notification'; id: string; text: string };

export interface ReducedActivityLine extends ActivityLine {
  step: ActivityStep;
}

function parseStep(text: string): ActivityStep | null {
  try {
    const value = JSON.parse(text) as Partial<ActivityStep>;
    if (!value || typeof value.kind !== 'string' || typeof value.id !== 'string' || !value.id) return null;
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
    const merged = { ...prior.step, ...step } as ActivityStep;
    reduced[position] = { ts: prior.ts, text: JSON.stringify(merged), step: merged };
  }

  return reduced.map(({ ts, step }) => ({ ts, text: JSON.stringify(step) }));
}

export function activityHint(lines: ActivityLine[]): string | null {
  const reduced = reduceActivityLines(lines);
  for (let i = reduced.length - 1; i >= 0; i--) {
    const step = parseStep(reduced[i].text);
    if (!step) continue;
    switch (step.kind) {
      case 'tool':
        if (step.status === 'error') return `${step.tool} failed`;
        if (step.status === 'completed') return `Used ${step.tool}`;
        return `Using ${step.tool}…`;
      case 'file': return `Opened ${step.name || step.path || 'a file'}`;
      case 'patch': return `Updated ${step.files.length === 1 ? step.files[0] : `${step.files.length} files`}`;
      case 'retry': return `Retrying (attempt ${step.attempt})…`;
      case 'compaction': return 'Compacting context…';
      case 'subtask': return step.description || (step.agent ? `Running ${step.agent} subtask…` : 'Running subtask…');
      case 'notification': return step.text;
      case 'reasoning': break;
    }
  }
  return null;
}
