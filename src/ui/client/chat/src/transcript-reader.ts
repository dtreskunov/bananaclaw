import { signal } from '@preact/signals';
import { channelType, groupId, messagingGroupId, threadId } from './state';
import { isSystemNotice } from './chat-protocol';
import type { TranscriptRow } from './types';
import { responseScrollTop, transcriptReadingTop } from './turn-completion';

export type ReaderNavigate = (action: () => void) => void;

export interface ReaderId {
  kind: 'message' | 'question';
  id: string;
}

export type ReadableRow = Extract<TranscriptRow, { kind: 'message' | 'question-answer' }>;
export interface ReaderPage {
  key: string;
  anchorId: string;
  row: ReadableRow;
}

export const readerSelection = signal<{ location: string; key: string } | null>(null);

export function readerLocation(): string {
  return JSON.stringify([groupId.value, threadId.value, channelType.value, messagingGroupId.value]);
}

export function readerKey(id: ReaderId): string {
  return `${id.kind}:${id.id}`;
}

export function openTranscriptReader(id: ReaderId): void {
  readerSelection.value = { location: readerLocation(), key: readerKey(id) };
}

export function readerPages(rows: readonly TranscriptRow[]): ReaderPage[] {
  const seen = new Set<string>();
  return rows.flatMap((row): ReaderPage[] => {
    let id: ReaderId;
    let anchorId: string;
    if (row.kind === 'message') {
      const message = row.message;
      if (
        message.direction === 'event' ||
        isSystemNotice(message.direction, message.systemGenerated, message.suggestedAction) ||
        (!message.text.trim() && !message.files?.length && !message.card)
      )
        return [];
      id = { kind: 'message', id: message.id };
      anchorId = message.id;
    } else if (row.kind === 'question-answer') {
      id = { kind: 'question', id: row.question.id };
      anchorId = row.answer.id;
    } else return [];
    const key = readerKey(id);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, anchorId, row }];
  });
}

export function alignReaderMessage(viewport: HTMLElement, message: HTMLElement): number {
  viewport.style.removeProperty('--reader-tail-space');
  const top = responseScrollTop(
    viewport.scrollTop,
    message.getBoundingClientRect().top,
    transcriptReadingTop(viewport),
  );
  const space = Math.max(0, top - Math.max(0, viewport.scrollHeight - viewport.clientHeight));
  viewport.style.setProperty('--reader-tail-space', `${space}px`);
  viewport.scrollTop = top;
  return viewport.scrollTop;
}
