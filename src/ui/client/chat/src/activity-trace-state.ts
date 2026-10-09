import { signal } from '@preact/signals';
import type { ChatMessage } from './types';

const traceOwner = signal<string | null>(null);
const metricsOwner = signal<string | null>(null);

export function activityMetricsExpanded(ownerId: string): boolean {
  return metricsOwner.value === ownerId;
}

export function toggleActivityMetrics(ownerId: string): void {
  metricsOwner.value = metricsOwner.peek() === ownerId ? null : ownerId;
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
  return traceOwner.value === ownerId;
}

export function toggleActivityTrace(ownerId: string): void {
  traceOwner.value = traceOwner.peek() === ownerId ? null : ownerId;
}

export function resetActivityTraceView(): void {
  traceOwner.value = null;
  metricsOwner.value = null;
}
