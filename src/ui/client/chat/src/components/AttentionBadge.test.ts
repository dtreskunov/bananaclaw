import { describe, expect, it } from 'vitest';
import { toChildArray } from 'preact';
import { AttentionBadge } from './AttentionBadge';

describe('inline attention badge', () => {
  it.each([1, 2, 12])('renders the compact count and attn label for %s requests', (count) => {
    const badge = AttentionBadge({ value: count, label: `${count} requests need your input` });
    expect(toChildArray(badge.props.children).join('')).toBe(`${count} attn`);
    expect(badge.props['aria-label']).toBe(`${count} requests need your input`);
    expect(badge.props.title).toBe(`${count} requests need your input`);
  });
});
