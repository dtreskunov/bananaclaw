import { signal } from '@preact/signals';
import { activityChapters, activityLineId, type TraceLine } from '../../../shared/activity-presentation';
import type { ChatMessage } from './types';

export interface ActivityTraceView {
  expanded: boolean;
  selectedEntry: string | null;
  openChapter: string | null;
  followLatest: boolean;
}

export const DEFAULT_TRACE_VIEW: ActivityTraceView = {
  expanded: false,
  selectedEntry: null,
  openChapter: null,
  followLatest: false,
};
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
  if (view.expanded) return { ...view, expanded: false, followLatest: false };
  const opened = { ...DEFAULT_TRACE_VIEW, expanded: true, followLatest: latest };
  return latest ? latestActivityTraceView(opened, lines) : opened;
}

export function latestActivityTraceView(view: ActivityTraceView, lines: TraceLine[]): ActivityTraceView {
  const chapter = activityChapters(lines, true).at(-1);
  return {
    ...view,
    selectedEntry: chapter?.entries.at(-1)?.id ?? null,
    openChapter: chapter && chapter.entries.length > 1 ? chapter.id : null,
  };
}

export function transferActivityTraceViews(previous: ChatMessage[], next: ChatMessage[]): void {
  const current = views.peek();
  if (!current.size) return;
  const retained = new Set(next.map(activityTraceId));
  const migrated = new Map(current);
  const followingTurns = new Set(
    previous.flatMap((message) => {
      const view = current.get(activityTraceId(message));
      return message.direction === 'turn' &&
        message.turnStatus &&
        message.turn &&
        message.turn.phase !== 'settled' &&
        view?.expanded &&
        view.followLatest
        ? [message.turn.id]
        : [];
    }),
  );
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
        const transferred = {
          ...view,
          followLatest: false,
          openChapter: openChapter?.id ?? null,
          selectedEntry: chapters.some((chapter) => chapter.entries.some((entry) => entry.id === view.selectedEntry))
            ? view.selectedEntry
            : null,
        };
        migrated.set(
          activityTraceId(reply),
          view.followLatest
            ? { ...latestActivityTraceView(transferred, reply.activity ?? []), followLatest: false }
            : transferred,
        );
      }
    }
    migrated.delete(id);
  }
  for (const message of next) {
    if (message.direction !== 'turn' || !message.turn || !followingTurns.has(message.turn.id)) continue;
    const id = activityTraceId(message);
    const view = migrated.get(id);
    if (message.turnStatus) {
      migrated.set(
        id,
        latestActivityTraceView(
          {
            ...(view ?? DEFAULT_TRACE_VIEW),
            expanded: true,
            followLatest: message.turn.phase !== 'settled',
          },
          message.activity ?? [],
        ),
      );
    } else if (view?.followLatest) {
      migrated.set(id, { ...view, followLatest: false });
    }
  }
  views.value = migrated;
}
