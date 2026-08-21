import type { ActivityLine } from './channels/adapter.js';

export type ActivityStep =
  | { kind: 'tool'; id: string; tool: string; status: 'pending' | 'running' | 'completed' | 'error'; detail?: string; title?: string; error?: string; durationMs?: number }
  | { kind: 'internal'; id: string; text: string }
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
      (merged.status === 'completed' || merged.status === 'error')
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

function cleanToolName(tool: string): string {
  if (tool.startsWith('mcp__')) {
    const rest = tool.slice(5);
    const [server, ...name] = rest.split('__');
    return `${server}.${name.join('.') || rest}`;
  }
  return tool.toLowerCase();
}

/** File-operation tools carry the target path but no verb (and OpenCode's
 *  title is just the path), so map the tool name to a verb to make read vs.
 *  write vs. edit explicit in the label. Case-insensitive so it covers both
 *  Claude (`Read`/`Write`/`Edit`) and OpenCode (`read`/`write`/`edit`). */
const FILE_OP_VERBS: Record<string, { present: string; past: string }> = {
  read: { present: 'Reading', past: 'Read' },
  write: { present: 'Writing', past: 'Wrote' },
  edit: { present: 'Editing', past: 'Edited' },
};

const COMMAND_TOOLS = new Set(['bash', 'shell', 'run', 'run_in_terminal']);

/** Canonical plain-text primary label used by typing hints. */
export function activityLabel(step: ActivityStep): string {
  switch (step.kind) {
      case 'tool': {
        const toolName = (step.tool || '').toLowerCase();
        const finished = step.status === 'completed' || step.status === 'error';
        const fileOp = FILE_OP_VERBS[toolName];
        if (fileOp) {
          const target = step.detail || step.title || '';
          const suffix = target ? ` ${target}` : '';
          return `${finished ? fileOp.past : fileOp.present}${suffix}`;
        }
        if (COMMAND_TOOLS.has(toolName) && step.detail) {
          return `${finished ? 'Ran' : 'Running'} ${step.detail.replace(/\s+/g, ' ').trim()}`;
        }
        if (step.title) {
          return step.detail ? `${step.title} ${step.detail.replace(/\s+/g, ' ').trim()}` : step.title;
        }
        const tool = cleanToolName(step.tool);
        return `${finished ? 'Used' : 'Using'} ${tool}`;
      }
      case 'internal': return 'Internal activity';
      case 'file': return `Opened ${step.name || step.path || 'file'}`;
      case 'patch': return `Updated ${step.files.length === 1 ? step.files[0] : `${step.files.length} files`}`;
      case 'retry': return `Retrying attempt ${step.attempt}`;
      case 'compaction': return step.auto ? 'Compacted context automatically' : 'Compacted context';
      case 'subtask': return step.agent ? `Started subtask with ${step.agent}` : step.description || 'Started subtask';
      case 'notification': return step.text;
  }
}
