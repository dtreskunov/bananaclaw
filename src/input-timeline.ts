import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import { parseInputState, type InputState } from './ui/shared/input-state.js';
import { parseTimelinePosition } from './ui/shared/timeline.js';

export function inputStateKey(messageId: string): string {
  return `input:${createHash('sha256').update(messageId).digest('hex')}`;
}

export function isCancelledInputContent(content: string): boolean {
  try {
    const value: unknown = JSON.parse(content);
    return !!value && typeof value === 'object' && 'cancelled' in value && value.cancelled === true;
  } catch (err) {
    if (err instanceof SyntaxError) return false;
    throw err;
  }
}

export function readInputTimeline(db: Database.Database, messageId: string): InputState | undefined {
  const row = db.prepare('SELECT value FROM session_state WHERE key = ?').get(inputStateKey(messageId)) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  try {
    const state = parseInputState(JSON.parse(row.value));
    return state?.messageId === messageId ? state : undefined;
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

export function outboundTimelinePosition(content: string): number | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === 'object' && 'timelinePosition' in value
      ? parseTimelinePosition(value.timelinePosition)
      : undefined;
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}
