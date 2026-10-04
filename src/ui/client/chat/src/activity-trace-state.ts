import { signal } from '@preact/signals';
import type { ChatMessage } from './types';

export type ActivityTraceMode = 'open' | 'follow';
export interface ActivityTraceIntent {
  ownerId: string;
  mode: ActivityTraceMode;
}

const intent = signal<ActivityTraceIntent | null>(null);

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

export function toggleActivityTrace(ownerId: string, follow = false): void {
  const current = intent.peek();
  intent.value = current?.ownerId === ownerId ? null : { ownerId, mode: follow ? 'follow' : 'open' };
}

export function pauseActivityTrace(ownerId: string): void {
  if (intent.peek()?.ownerId === ownerId) intent.value = { ownerId, mode: 'open' };
}

export function resetActivityTraceView(): void {
  intent.value = null;
}
