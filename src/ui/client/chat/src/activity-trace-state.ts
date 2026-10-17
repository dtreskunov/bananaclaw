import { signal } from '@preact/signals';
import { appearance } from './appearance-state';
import type { ChatMessage } from './types';

/** `follow` panels move to each new response; `open` panels stay where they were opened. */
type Mode = 'open' | 'follow';

// Any number of Steps and Stats panels can be open at once.
const traceOpen = signal<ReadonlyMap<string, Mode>>(new Map());
const metricsOpen = signal<ReadonlyMap<string, Mode>>(new Map());
// The first live response in a conversation opens its trace unless the user already toggled one.
let initialTracePending = true;

function toggle(panel: typeof traceOpen, ownerId: string, follow: boolean): void {
  const next = new Map(panel.peek());
  if (!next.delete(ownerId)) next.set(ownerId, follow ? 'follow' : 'open');
  panel.value = next;
}

function move(panel: typeof traceOpen, from: string, to: string): void {
  const next = new Map(panel.peek());
  const mode = next.get(from)!;
  next.delete(from);
  next.set(to, mode);
  panel.value = next;
}

export function activityMetricsExpanded(ownerId: string): boolean {
  return metricsOpen.value.has(ownerId);
}

export function toggleActivityMetrics(ownerId: string, follow = false): void {
  toggle(metricsOpen, ownerId, follow);
}

export function activityTraceOwner(message: ChatMessage): string {
  if (message.turnTraceOwner) {
    if (!message.turnId) throw new Error('Activity trace owner is missing its authoritative turn ID');
    return `turn:${message.turnId}`;
  }
  if (!message.id) throw new Error('Activity trace message is missing its authoritative ID');
  return `message:${message.id}`;
}

export function activityTraceExpanded(ownerId: string): boolean {
  return traceOpen.value.has(ownerId);
}

export function toggleActivityTrace(ownerId: string, follow = false): void {
  initialTracePending = false;
  toggle(traceOpen, ownerId, follow);
}

export function submissionTraceOwner(messageId: string): string {
  return `submission:${messageId}`;
}

/** A new response starts: following panels move to it, and the conversation's first one opens its trace. */
export function inheritActivityPanels(ownerId: string): void {
  for (const panel of [traceOpen, metricsOpen]) {
    for (const [from, mode] of panel.peek()) if (mode === 'follow' && from !== ownerId) move(panel, from, ownerId);
  }
  if (initialTracePending && appearance.peek().preferences.showTechnicalStatus) {
    initialTracePending = false;
    if (!traceOpen.peek().has(ownerId)) toggle(traceOpen, ownerId, true);
  }
}

/** A pre-turn trace or usage view stays open once the turn that claimed its submission takes over the row. */
export function adoptSubmissionTraces(turns: readonly { id: string; inputIds: readonly string[] }[]): void {
  for (const turn of turns) {
    for (const id of turn.inputIds) {
      for (const panel of [traceOpen, metricsOpen]) {
        if (panel.peek().has(submissionTraceOwner(id))) move(panel, submissionTraceOwner(id), `turn:${turn.id}`);
      }
    }
  }
}

export function resetActivityTraceView(): void {
  traceOpen.value = new Map();
  metricsOpen.value = new Map();
  initialTracePending = true;
}
