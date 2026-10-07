import { signal } from '@preact/signals';
import type { ChatMessage } from './types';

export type ActivityTraceMode = 'open' | 'follow';
export interface ActivityTraceIntent {
  ownerId: string;
  mode: ActivityTraceMode;
}

const intent = signal<ActivityTraceIntent | null>(null);
const expandedMetrics = signal<ReadonlySet<string>>(new Set());

export function activityMetricsExpanded(ownerId: string): boolean {
  return expandedMetrics.value.has(ownerId);
}

export function toggleActivityMetrics(ownerId: string): void {
  const next = new Set(expandedMetrics.peek());
  if (next.has(ownerId)) next.delete(ownerId);
  else next.add(ownerId);
  expandedMetrics.value = next;
}

export function activityTraceOwner(message: ChatMessage): string {
  if (message.turnTraceOwner) {
    if (!message.turnId) throw new Error('Activity trace owner is missing its authoritative turn ID');
    return `turn:${message.turnId}`;
  }
  if (!message.id) throw new Error('Activity trace message is missing its authoritative ID');
  return `message:${message.id}`;
}

export function activityTraceView(ownerId: string, live = false): { expanded: boolean; following: boolean } {
  const current = intent.value;
  const expanded = current?.ownerId === ownerId;
  return { expanded, following: expanded && current.mode === 'follow' && live };
}

export function activityTraceFollowing(ownerId: string): boolean {
  const current = intent.value;
  return current?.ownerId === ownerId && current.mode === 'follow';
}

export function toggleActivityTrace(ownerId: string, follow = false): void {
  const current = intent.peek();
  intent.value = current?.ownerId === ownerId ? null : { ownerId, mode: follow ? 'follow' : 'open' };
}

export function pauseActivityTrace(ownerId: string): void {
  if (intent.peek()?.ownerId === ownerId) intent.value = { ownerId, mode: 'open' };
}

export function followActivityTrace(ownerId: string): void {
  if (intent.peek()?.ownerId === ownerId) intent.value = { ownerId, mode: 'follow' };
}

export function inheritActivityTrace(ownerId: string, automatic = false): void {
  const current = intent.peek();
  if (automatic || (current?.mode === 'follow' && current.ownerId !== ownerId))
    intent.value = { ownerId, mode: 'follow' };
}

export function resetActivityTraceView(): void {
  intent.value = null;
  expandedMetrics.value = new Set();
}
