import { signal } from '@preact/signals';
import type { ChatMessage } from './types';

export type ActivityPanelMode = 'open' | 'follow';
export interface ActivityPanelIntent {
  ownerId: string;
  mode: ActivityPanelMode;
}

const intent = signal<ActivityPanelIntent | null>(null);
const metricsIntent = signal<ActivityPanelIntent | null>(null);

export function activityMetricsExpanded(ownerId: string): boolean {
  return metricsIntent.value?.ownerId === ownerId;
}

export function toggleActivityMetrics(ownerId: string, follow = false): void {
  const current = metricsIntent.peek();
  metricsIntent.value = current?.ownerId === ownerId ? null : { ownerId, mode: follow ? 'follow' : 'open' };
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

export function inheritActivityPanels(ownerId: string, openInitialTrace = false): void {
  if (openInitialTrace && !intent.peek()) intent.value = { ownerId, mode: 'follow' };
  for (const panel of [intent, metricsIntent]) {
    const current = panel.peek();
    if (current?.mode === 'follow' && current.ownerId !== ownerId) panel.value = { ...current, ownerId };
  }
}

export function resetActivityTraceView(): void {
  intent.value = null;
  metricsIntent.value = null;
}
