import { describe, expect, it } from 'vitest';

import { normalizeDisplayCardPayload } from './display-card.js';

describe('normalizeDisplayCardPayload', () => {
  it('normalizes supported content and safe link actions', () => {
    expect(
      normalizeDisplayCardPayload({
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['First', { text: 'Second' }, { unsupported: true }, '  '],
          actions: [
            { label: 'Open', url: 'https://example.com/report', style: 'primary' },
            { label: 'Email', url: 'mailto:ops@example.com' },
            { label: 'Ignore', url: 'javascript:alert(1)' },
            { label: 'No URL' },
          ],
        },
        fallbackText: 'Daily fallback',
      }),
    ).toEqual({
      card: {
        title: 'Daily',
        description: 'Your plate today',
        children: ['First', 'Second'],
        actions: [
          { label: 'Open', url: 'https://example.com/report', style: 'primary' },
          { label: 'Email', url: 'mailto:ops@example.com' },
        ],
      },
      fallbackText: 'Daily fallback',
    });
  });

  it('derives fallback text from description, then title', () => {
    expect(
      normalizeDisplayCardPayload({
        type: 'card',
        card: { title: 'Title', description: 'Description' },
      })?.fallbackText,
    ).toBe('Description');
    expect(
      normalizeDisplayCardPayload({
        type: 'card',
        card: { title: 'Title' },
      })?.fallbackText,
    ).toBe('Title');
  });

  it('preserves fallback-only cards without inventing structured content', () => {
    expect(
      normalizeDisplayCardPayload({
        type: 'card',
        card: {},
        fallbackText: 'Plain fallback',
      }),
    ).toEqual({ card: null, fallbackText: 'Plain fallback' });
  });

  it('rejects malformed and non-card payloads', () => {
    expect(normalizeDisplayCardPayload(null)).toBeNull();
    expect(normalizeDisplayCardPayload({ type: 'unknown', card: {} })).toBeNull();
    expect(normalizeDisplayCardPayload({ type: 'card', card: null })).toBeNull();
  });
});
