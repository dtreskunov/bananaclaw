import { describe, expect, it } from 'vitest';
import { readStoppedTurnStats } from './stopped-turn.js';

describe('stopped response metadata for history and live delivery', () => {
  it.each(['native/MiniMax-M3', null])('preserves elapsed time with model %s', (model) => {
    expect(readStoppedTurnStats({ stopped: true, stopped_stats: { durationMs: 12500, model } })).toEqual({
      durationMs: 12500,
      model,
    });
  });

  it.each([
    null,
    {},
    { durationMs: -1, model: null },
    { durationMs: Infinity, model: null },
    { durationMs: '12', model: 'model' },
    { durationMs: 12, model: {} },
  ])('rejects invalid metadata: %j', (stats) => {
    expect(readStoppedTurnStats({ stopped: true, stopped_stats: stats })).toBeUndefined();
  });

  it('does not mark normal or legacy messages as having interrupted statistics', () => {
    expect(readStoppedTurnStats({ stopped: true })).toBeUndefined();
    expect(readStoppedTurnStats({ stopped_stats: { durationMs: 12, model: 'model' } })).toBeUndefined();
  });
});
