import { describe, it, expect } from 'bun:test';

import { normalizeAssistantText } from './opencode.js';

describe('normalizeAssistantText — leading "<" restore', () => {
  it('restores a stripped <message> open tag', () => {
    expect(normalizeAssistantText('message to="web">hi</message>')).toBe(
      '<message to="web">hi</message>',
    );
  });

  it('restores a stripped <internal> tag', () => {
    expect(normalizeAssistantText('internal>notes</internal>')).toBe('<internal>notes</internal>');
  });

  it('leaves text that only looks tag-shaped alone (no false positive)', () => {
    // The old heuristic (^[a-z][\w-]*(…="|>)) would have prepended '<' here.
    expect(normalizeAssistantText('code> is how you format inline code')).toBe(
      'code> is how you format inline code',
    );
  });

  it('does not touch text that already starts with "<"', () => {
    expect(normalizeAssistantText('<message to="web">ok</message>')).toBe(
      '<message to="web">ok</message>',
    );
  });
});

describe('normalizeAssistantText — chain-of-thought stripping', () => {
  it('strips a balanced inline <think> block, keeping the message', () => {
    expect(normalizeAssistantText('<think>reasoning</think>\n\n<message to="web">Hi</message>')).toBe(
      '<message to="web">Hi</message>',
    );
  });

  it('restores the leading "<" of <think> then strips the whole block', () => {
    // OpenCode dropped the leading '<' of <think>; restore makes it whole so
    // the block can be recognized and removed rather than leaked.
    expect(normalizeAssistantText('think>reasoning</think><message to="web">Hi</message>')).toBe(
      '<message to="web">Hi</message>',
    );
  });

  it('strips an orphaned leading </think> tail (opening tag lost upstream)', () => {
    const leaked = '` since the user asked from that channel.</think>\n\n<message to="web">Hi</message>';
    expect(normalizeAssistantText(leaked)).toBe('<message to="web">Hi</message>');
  });

  it('yields empty string when the text is only reasoning', () => {
    expect(normalizeAssistantText('<think>only thinking, no answer</think>')).toBe('');
  });
});
