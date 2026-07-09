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

  it('repairs a missing angle bracket after leading whitespace', () => {
    expect(normalizeAssistantText('\n  message to="web">hi</message>')).toBe(
      '<message to="web">hi</message>',
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

  describe('log-derived malformed model output', () => {
    const cases: Array<[string, string, string]> = [
      [
        'unclosed think containing the real delivery block',
        '<think>The user wants a short answer.<message to="web-mg-web-0">Here it is.</message>',
        '<message to="web-mg-web-0">Here it is.</message>',
      ],
      [
        'orphan close emitted as the entire text part',
        '</think>',
        '',
      ],
      [
        'lost opening angle on a delivery block',
        'message to="web-mg-web-1">I can help.</message>',
        '<message to="web-mg-web-1">I can help.</message>',
      ],
      [
        'reasoning-only turn with no closing tag',
        '<think>The model stopped before writing a reply.',
        '',
      ],
      [
        'visible reply followed by a stray unclosed reasoning block',
        '<message to="web">Done.</message><think>trailing private notes',
        '<message to="web">Done.</message>',
      ],
      [
        'internal block inside an unclosed reasoning block',
        '<think>private preamble<internal>scratchpad</internal>',
        '<internal>scratchpad</internal>',
      ],
    ];

    for (const [name, raw, expected] of cases) {
      it(name, () => {
        expect(normalizeAssistantText(raw)).toBe(expected);
      });
    }
  });
});
