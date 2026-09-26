import { describe, expect, it } from 'vitest';
import { parseInputState } from './input-state.js';
import { parseTimelinePosition, timelineSortKey } from './timeline.js';

describe('durable timeline positions', () => {
  const timestamp = '2026-09-26T00:00:00.000Z';
  const base = Date.parse(timestamp) * 1000;

  it('uses logical order without changing or truncating same-millisecond positions', () => {
    expect(timelineSortKey(timestamp, base + 2)).toBe(base + 2);
    expect(timelineSortKey('2026-09-25 00:00:00', base + 3)).toBeGreaterThan(timelineSortKey(timestamp, base + 2));
  });

  it('retains legacy chronology for ISO and SQLite timestamps', () => {
    expect(timelineSortKey(timestamp)).toBe(base);
    expect(timelineSortKey('2026-09-26 00:00:00')).toBe(base);
    expect(timelineSortKey('invalid')).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '123', null])(
    'rejects an invalid position %s',
    (value) => {
      expect(parseTimelinePosition(value)).toBeUndefined();
      expect(parseInputState({ messageId: 'input', status: 'queued', timelinePosition: value })).toBeUndefined();
    },
  );

  it('preserves the durable order and explicit queue disposition', () => {
    const state = { messageId: 'input', status: 'queued', queuedForNextTurn: true, timelinePosition: base };
    expect(parseInputState(state)).toEqual(state);
    expect(parseInputState({ ...state, queuedForNextTurn: 'true' })).toBeUndefined();
  });
});
