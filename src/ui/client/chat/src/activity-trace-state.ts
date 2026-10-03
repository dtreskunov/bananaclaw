import { signal } from '@preact/signals';
import { activityChapters, activityLineId, type TraceLine } from '../../../shared/activity-presentation';
import type { ChatMessage } from './types';

export interface ActivityTraceView {
  expanded: boolean;
  selectedEntry: string | null;
  openChapter: string | null;
}

export const DEFAULT_TRACE_VIEW: ActivityTraceView = { expanded: false, selectedEntry: null, openChapter: null };
const views = signal(new Map<string, ActivityTraceView>());

export function activityTraceId(message: ChatMessage): string {
  return message.id || `${message.direction}:${message.ts}:${message.text}`;
}

export function activityTraceView(id: string): ActivityTraceView {
  return views.value.get(id) ?? DEFAULT_TRACE_VIEW;
}

export function updateActivityTraceView(id: string, update: (view: ActivityTraceView) => ActivityTraceView): void {
  const next = new Map(views.peek());
  next.set(id, update(next.get(id) ?? DEFAULT_TRACE_VIEW));
  views.value = next;
}

export function resetActivityTraceViews(): void {
  views.value = new Map();
}

export function toggleActivityTrace(view: ActivityTraceView, lines: TraceLine[], latest = false): ActivityTraceView {
  if (view.expanded) return { ...view, expanded: false };
  return {
    expanded: true,
    selectedEntry: latest && lines.length ? activityLineId(lines[lines.length - 1], lines.length - 1) : null,
    openChapter: latest ? (activityChapters(lines, true).at(-1)?.id ?? null) : null,
  };
}

export function transferActivityTraceViews(previous: ChatMessage[], next: ChatMessage[]): void {
  const current = views.peek();
  if (!current.size) return;
  const retained = new Set(next.map(activityTraceId));
  const migrated = new Map(current);
  for (const message of previous) {
    const id = activityTraceId(message);
    if (retained.has(id)) continue;
    const view = current.get(id);
    if (view?.expanded && message.direction === 'turn' && message.turn) {
      const entries = new Set(message.activity?.map(activityLineId));
      const reply = next.find(
        (item) =>
          item.direction === 'out' &&
          item.turnId === message.turn?.id &&
          item.activity?.some((line, index) => entries.has(activityLineId(line, index))),
      );
      if (reply) {
        const chapters = activityChapters(reply.activity ?? []);
        const openChapter = chapters.find((chapter) => chapter.entries.some((entry) => entry.id === view.openChapter));
        migrated.set(activityTraceId(reply), {
          ...view,
          openChapter: openChapter?.id ?? null,
          selectedEntry: chapters.some((chapter) => chapter.entries.some((entry) => entry.id === view.selectedEntry))
            ? view.selectedEntry
            : null,
        });
      }
    }
    migrated.delete(id);
  }
  views.value = migrated;
}
