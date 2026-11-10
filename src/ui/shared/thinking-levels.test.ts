import { describe, expect, it } from 'vitest';
import { thinkingLevelError, thinkingLevelLabel, thinkingLevels } from './thinking-levels.js';

describe('thinking levels', () => {
  it('does not offer controls for unsupported providers, unknown models or noncanonical native IDs', () => {
    for (const provider of ['opencode', 'mock', null]) expect(thinkingLevels(provider, 'openai/gpt-5')).toEqual([]);
    expect(thinkingLevels('native', 'gpt-5')).toEqual([]);
    expect(thinkingLevels('native', null)).toEqual([]);
    expect(thinkingLevels('native', 'local/unknown')).toEqual([]);
  });

  it('keeps current Claude aliases usable without guessing their highest effort', () => {
    expect(thinkingLevels('claude', 'opus')).toEqual(['low', 'medium', 'high']);
    expect(thinkingLevels('claude', 'sonnet')).toEqual(['low', 'medium', 'high']);
  });

  it('accepts defaults but explicitly rejects unsupported values and combinations', () => {
    expect(thinkingLevelError('native', 'local/unknown', null)).toBeNull();
    expect(thinkingLevelError('native', 'local/unknown', '')).toBeNull();
    for (const value of ['none', 'off', true, 123, {}, 'HIGH']) {
      expect(thinkingLevelError('native', 'minimax/MiniMax-M3.1-Flash', value)).toContain('must be one of');
    }
    expect(thinkingLevelError('opencode', 'openai/gpt-5', 'high')).toContain('not supported');
    expect(thinkingLevelError('native', 'openai/gpt-5.1', 'none')).toBeNull();
  });

  it('uses understandable labels without changing wire values', () => {
    expect(['none', 'low', 'medium', 'high', 'xhigh', 'max'].map(thinkingLevelLabel)).toEqual([
      'Off',
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Maximum',
    ]);
  });
});
