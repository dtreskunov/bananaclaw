import { describe, expect, it } from 'vitest';
import {
  defaultThinkingLevel,
  isThinkingLevel,
  thinkingLevelError,
  thinkingLevelLabel,
  thinkingLevels,
} from './thinking-levels.js';

describe('thinking levels', () => {
  it('validates recorded levels without accepting unknown/default values', () => {
    for (const level of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) expect(isThinkingLevel(level)).toBe(true);
    for (const level of [undefined, null, '', 'default', 'invalid', 1, true])
      expect(isThinkingLevel(level)).toBe(false);
  });
  it.each([
    ['minimax/MiniMax-M3.1-Flash', 'max'],
    ['minimax-coding-plan/MiniMax-M3.1-Flash-Preview', 'max'],
    ['openai/gpt-5', 'medium'],
    ['openai/gpt-5-mini', 'medium'],
    ['openai/o3-mini', 'medium'],
    ['openai/gpt-5.1', 'none'],
    ['openai/gpt-5.2', 'none'],
    ['openai/gpt-5.4-2026-03-05', 'none'],
    ['anthropic/claude-opus-4-6', 'high'],
    ['anthropic/claude-opus-5-5', 'medium'],
    ['anthropic/claude-sonnet-5-5', 'high'],
    ['local/unknown', null],
  ])('initializes %s to its reviewed API default %s', (model, expected) => {
    expect(defaultThinkingLevel('native', model)).toBe(expected);
    if (expected !== null) expect(thinkingLevels('native', model)).toContain(expected);
  });

  it('does not assume API defaults for SDK-owned settings or unsupported providers/models', () => {
    expect(defaultThinkingLevel('claude', 'claude-opus-4-6')).toBeNull();
    expect(defaultThinkingLevel('opencode', 'openai/gpt-5')).toBeNull();
    expect(defaultThinkingLevel('native', 'gpt-5')).toBeNull();
    expect(defaultThinkingLevel('native', null)).toBeNull();
  });

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
